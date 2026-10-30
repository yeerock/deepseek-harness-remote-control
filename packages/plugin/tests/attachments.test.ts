import { describe, expect, it, vi } from 'vitest';
import { AttachmentStaging, CHUNK_BYTES, MAX_FILE_BYTES, safeFileName, sniffImage } from '../src/attachments.js';
import { dispatchEndpoint, isPeerEndpoint, type SharingRpcTarget } from '../src/host.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('attachment staging', () => {
  it('recognises images by their bytes, never by name', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a....'))).toBe('image/gif');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('image/webp');
    expect(sniffImage(Buffer.from('<svg onload=alert(1)>'))).toBeUndefined();
    expect(sniffImage(Buffer.from('%PDF-1.7'))).toBeUndefined();
  });

  it('keeps only a plain file name', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Users\\a\\report.pdf')).toBe('report.pdf');
    expect(safeFileName('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName(42)).toBe('file');
  });

  it('assembles pieces in order and hands the file out once', () => {
    const staging = new AttachmentStaging();
    const { uploadId, chunkBytes } = staging.begin('shot.png', PNG.length);
    expect(chunkBytes).toBe(CHUNK_BYTES);
    expect(staging.append(uploadId, 0, PNG.subarray(0, 4).toString('base64'))).toEqual({ received: 4, complete: false });
    expect(() => staging.append(uploadId, 0, PNG.subarray(4).toString('base64'))).toThrow(/out of order/);
    expect(staging.append(uploadId, 4, PNG.subarray(4).toString('base64'))).toEqual({ received: PNG.length, complete: true });
    expect(staging.take(uploadId)).toEqual({ name: 'shot.png', bytes: PNG });
    expect(() => staging.take(uploadId)).toThrow(/expired/);
  });

  it('refuses oversize, overlong, damaged and unknown uploads', () => {
    const staging = new AttachmentStaging();
    expect(() => staging.begin('big', MAX_FILE_BYTES + 1)).toThrow(/up to/);
    expect(() => staging.begin('none', 0)).toThrow(/empty/);
    const { uploadId } = staging.begin('a', 3);
    expect(() => staging.append(uploadId, 0, Buffer.from('abcd').toString('base64'))).toThrow(/wrong size/);
    expect(() => staging.append(uploadId, 0, 'not base64!')).toThrow(/damaged/);
    expect(() => staging.append('up_guess', 0, 'YQ==')).toThrow(/expired/);
    expect(() => staging.take(uploadId)).toThrow(/not finished/);
  });

  it('caps what is staged at once and forgets uploads after ten minutes', () => {
    let now = 0;
    const staging = new AttachmentStaging(() => now);
    for (let i = 0; i < 3; i += 1) staging.begin('f', MAX_FILE_BYTES);
    expect(() => staging.begin('f', MAX_FILE_BYTES)).toThrow(/busy/);
    now += 11 * 60_000;
    expect(() => staging.begin('f', MAX_FILE_BYTES)).not.toThrow();
  });

  it('keeps a file staged until it is used, so a failed send can retry', () => {
    const staging = new AttachmentStaging();
    const { uploadId } = staging.begin('a.txt', 1);
    staging.append(uploadId, 0, Buffer.from('a').toString('base64'));
    expect(staging.peek(uploadId).name).toBe('a.txt');
    expect(staging.peek(uploadId).name).toBe('a.txt');
    staging.discard(uploadId);
    expect(() => staging.peek(uploadId)).toThrow(/expired/);
  });

  it('frees an abandoned upload after a minute without pieces', () => {
    let now = 0;
    const staging = new AttachmentStaging(() => now);
    const { uploadId } = staging.begin('big', 10);
    staging.append(uploadId, 0, Buffer.from('abc').toString('base64'));
    now += 30_000;
    expect(() => staging.append(uploadId, 3, Buffer.from('d').toString('base64'))).not.toThrow();
    now += 61_000;
    expect(() => staging.append(uploadId, 4, Buffer.from('e').toString('base64'))).toThrow(/expired/);
  });

  it('removes characters that could fake a file extension on screen', () => {
    expect(safeFileName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
  });

  it('checks every file before a prompt takes any', () => {
    const staging = new AttachmentStaging();
    const done = staging.begin('a', 1);
    staging.append(done.uploadId, 0, Buffer.from('a').toString('base64'));
    const half = staging.begin('b', 2);
    expect(() => staging.assertReady([done.uploadId, half.uploadId])).toThrow(/not finished/);
    expect(staging.take(done.uploadId).name).toBe('a');
  });
});

describe('attachment endpoints', () => {
  it('are peer calls on the receiving computer and relays on the sending one', async () => {
    for (const ok of ['remote.uploadBegin', 'remote.uploadChunk', 'remote.uploadDiscard']) expect(isPeerEndpoint(ok), ok).toBe(true);
    const peerCall = vi.fn(async () => ({ uploadId: 'up_x' }));
    await dispatchEndpoint({ peerCall } as unknown as SharingRpcTarget, 'session.uploadChunk', { deviceId: 'dev_x', uploadId: 'up_x', offset: 0, data: 'YQ==' });
    expect(peerCall).toHaveBeenCalledWith('dev_x', 'remote.uploadChunk', { uploadId: 'up_x', offset: 0, data: 'YQ==' });
  });

  it('accept a prompt that is only files, and refuse one with neither text nor files', async () => {
    const localPrompt = vi.fn(async () => ({ accepted: true as const }));
    const target = { localPrompt } as unknown as SharingRpcTarget;
    await expect(dispatchEndpoint(target, 'remote.prompt', { sessionId: 's1', text: '', uploadIds: ['up_a'] })).resolves.toMatchObject({ ok: true });
    expect(localPrompt).toHaveBeenCalledWith('s1', '', ['up_a']);
    await expect(dispatchEndpoint(target, 'remote.prompt', { sessionId: 's1', text: '  ' })).resolves.toMatchObject({ ok: false });
  });
});
