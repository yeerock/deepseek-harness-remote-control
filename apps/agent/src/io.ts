/**
 * Byte and backpressure helpers shared by the HTTP/WS proxies.
 *
 * The agent never buffers a whole body: every writer awaits socket credit
 * (`stream.write` on mux streams, `writeWithDrain` on Node sockets), so a slow
 * phone cannot balloon memory on the desktop.
 */
import type { Writable } from 'node:stream';

const encoder = new TextEncoder();

export function toBytes(data: string | Uint8Array | ArrayBuffer | ArrayBufferView | Buffer[]): Uint8Array {
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const buffers = data.map((chunk) => Buffer.from(chunk));
    return new Uint8Array(Buffer.concat(buffers));
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Write one chunk and resolve only once the kernel accepted it. */
export async function writeWithDrain(writable: Writable, chunk: Uint8Array): Promise<void> {
  if (writable.destroyed) throw new Error('destination destroyed');
  if (writable.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      writable.off('drain', onDrain);
      writable.off('close', onClose);
      writable.off('error', onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('destination closed before drain'));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    writable.once('drain', onDrain);
    writable.once('close', onClose);
    writable.once('error', onError);
  });
}