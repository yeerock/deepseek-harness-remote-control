/**
 * Attachments a peer sends with a prompt.
 *
 * A peer call is capped at 256 KiB, so files arrive in chunks and wait here
 * (in memory, bounded, short-lived) until the prompt that uses them. Then an
 * image becomes an inline image part, as the local composer sends it, and any
 * other file goes through the Harness's own upload service as a receipt.
 */
import { randomBytes } from 'node:crypto';

/** Largest piece of a file in one call, before base64 (base64 + JSON stays under the RPC cap). */
export const CHUNK_BYTES = 160 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES_PER_PROMPT = 10;
/** Everything staged on this computer at once, across peers. */
const MAX_STAGED_BYTES = 64 * 1024 * 1024;
const MAX_STAGED_UPLOADS = 40;
const UPLOAD_TTL_MS = 10 * 60_000;
/** An upload that stopped receiving pieces (window closed) frees its room after this. */
const IDLE_TTL_MS = 60_000;
const UPLOAD_ID = /^up_[A-Za-z0-9_-]{22}$/;

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

interface Staged {
  name: string;
  size: number;
  chunks: Buffer[];
  received: number;
  createdAt: number;
  lastActivity: number;
}

/** The media type of an image from its first bytes; never from its name. */
export function sniffImage(bytes: Buffer): ImageMediaType | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' || bytes.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}

/** A display name with no path, control characters or surprises. */
export function safeFileName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  const base = text.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  // Control characters, and bidirectional overrides that could fake an extension on screen.
  const clean = base.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 120);
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean;
}

export class AttachmentStaging {
  private readonly uploads = new Map<string, Staged>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Reserve room for one file; returns its upload id. */
  begin(name: unknown, size: unknown): { uploadId: string; chunkBytes: number } {
    this.sweep();
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) throw new Error('The file is empty.');
    if (size > MAX_FILE_BYTES) throw new Error(`Files can be up to ${String(MAX_FILE_BYTES / 1024 / 1024)} MB.`);
    if (this.uploads.size >= MAX_STAGED_UPLOADS || this.stagedBytes() + size > MAX_STAGED_BYTES) {
      throw new Error('That computer is busy receiving other files. Try again in a moment.');
    }
    const uploadId = `up_${randomBytes(16).toString('base64url')}`;
    this.uploads.set(uploadId, { name: safeFileName(name), size, chunks: [], received: 0, createdAt: this.now(), lastActivity: this.now() });
    return { uploadId, chunkBytes: CHUNK_BYTES };
  }

  /** Append the next piece, in order; `offset` must equal the bytes received so far. */
  append(uploadId: unknown, offset: unknown, base64: unknown): { received: number; complete: boolean } {
    const staged = this.get(uploadId);
    if (typeof offset !== 'number' || offset !== staged.received) throw new Error('A piece of the file arrived out of order. Try again.');
    if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('A piece of the file was damaged. Try again.');
    const piece = Buffer.from(base64, 'base64');
    if (piece.length === 0 || piece.length > CHUNK_BYTES || staged.received + piece.length > staged.size) throw new Error('A piece of the file was the wrong size. Try again.');
    staged.chunks.push(piece);
    staged.received += piece.length;
    staged.lastActivity = this.now();
    return { received: staged.received, complete: staged.received === staged.size };
  }

  /**
   * Read a complete file without removing it: it stays staged (and counted)
   * until the prompt that uses it succeeds, so a failed send can be retried.
   */
  peek(uploadId: unknown): { name: string; bytes: Buffer } {
    const staged = this.get(uploadId);
    if (staged.received !== staged.size) throw new Error(`"${staged.name}" has not finished uploading.`);
    staged.lastActivity = this.now();
    return { name: staged.name, bytes: Buffer.concat(staged.chunks, staged.size) };
  }

  /** Read and remove (tests and one-shot callers). */
  take(uploadId: unknown): { name: string; bytes: Buffer } {
    const file = this.peek(uploadId);
    this.uploads.delete(uploadId as string);
    return file;
  }

  /** Check that every id is complete, without taking any (so a bad prompt changes nothing). */
  assertReady(uploadIds: unknown[]): void {
    for (const id of uploadIds) {
      const staged = this.get(id);
      if (staged.received !== staged.size) throw new Error(`"${staged.name}" has not finished uploading.`);
    }
  }

  discard(uploadId: unknown): void {
    if (typeof uploadId === 'string') this.uploads.delete(uploadId);
  }

  private get(uploadId: unknown): Staged {
    this.sweep();
    const staged = typeof uploadId === 'string' && UPLOAD_ID.test(uploadId) ? this.uploads.get(uploadId) : undefined;
    if (staged === undefined) throw new Error('That file upload expired. Attach it again.');
    return staged;
  }

  private stagedBytes(): number {
    let total = 0;
    for (const staged of this.uploads.values()) total += staged.size;
    return total;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, staged] of this.uploads) {
      const abandoned = staged.received < staged.size && now - staged.lastActivity > IDLE_TTL_MS;
      if (now - staged.createdAt > UPLOAD_TTL_MS || abandoned) this.uploads.delete(id);
    }
  }
}
