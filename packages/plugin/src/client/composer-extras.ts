/**
 * Attach files and dictate for remote sessions, the way the local composer does.
 *
 * Files are sent to the other computer in pieces (a peer call is capped at
 * 256 KiB) and attached to the next message there. Voice never leaves this
 * computer: it is recorded and transcribed here by DeepSeek Harness's own
 * voice input (the `speech` service), and only the text goes into the draft.
 */

type Call = (endpoint: string, payload?: unknown) => Promise<any>;

/* -------------------------------- files -------------------------------- */

export interface PendingFile {
  key: string;
  file: File;
  name: string;
  size: number;
  isImage: boolean;
  /** Object URL for an image preview; revoke with {@link releaseFile}. */
  preview?: string;
  uploadId?: string;
  progress: number;
  failed?: string;
}

let fileCounter = 0;

export function pendingFile(file: File): PendingFile {
  fileCounter += 1;
  const isImage = /^image\/(png|jpeg|webp|gif)$/.test(file.type);
  let preview: string | undefined;
  if (isImage) {
    try { preview = URL.createObjectURL(file); } catch { /* no preview */ }
  }
  return { key: `f${String(fileCounter)}`, file, name: file.name || 'file', size: file.size, isImage, ...(preview === undefined ? {} : { preview }), progress: 0 };
}

export function releaseFile(file: PendingFile): void {
  if (file.preview !== undefined) {
    try { URL.revokeObjectURL(file.preview); } catch { /* already gone */ }
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

/**
 * Send one file to the other computer in order; returns its upload id there.
 * `onProgress` gets 0..1. Throws a plain message on failure.
 */
export async function uploadFile(call: Call, deviceId: string, file: PendingFile, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<string> {
  const begun = (await call('session.uploadBegin', { deviceId, name: file.name, size: file.size })) as { uploadId?: string; chunkBytes?: number };
  const uploadId = begun.uploadId;
  const chunk = begun.chunkBytes;
  if (typeof uploadId !== 'string' || typeof chunk !== 'number' || chunk < 1) throw new Error('That computer did not accept the file.');
  let offset = 0;
  try {
    while (offset < file.size) {
      if (signal?.aborted === true) throw new Error('Cancelled.');
      const piece = new Uint8Array(await file.file.slice(offset, offset + chunk).arrayBuffer());
      await call('session.uploadChunk', { deviceId, uploadId, offset, data: toBase64(piece) });
      offset += piece.length;
      onProgress(offset / file.size);
    }
  } catch (error) {
    void call('session.uploadDiscard', { deviceId, uploadId }).catch(() => undefined);
    throw error;
  }
  return uploadId;
}

/* -------------------------------- voice -------------------------------- */

/** The slice of DeepSeek Harness's speech service this view uses. */
export interface SpeechService {
  catalog?: () => Promise<unknown>;
  transcribe?: (request: { audioBase64: string; providerId: string; language: string }, signal?: AbortSignal) => Promise<unknown>;
}

export interface VoiceReadiness {
  ready: boolean;
  providerId?: string;
  language?: string;
  maxDurationSeconds: number;
  maxAudioBytes: number;
}

/** Whether dictation can run on this computer now, from the speech catalog. */
export async function voiceReadiness(speech: SpeechService | undefined): Promise<VoiceReadiness | undefined> {
  if (speech === undefined || typeof speech.catalog !== 'function' || typeof speech.transcribe !== 'function') return undefined;
  const raw = (await speech.catalog()) as Record<string, any>;
  const value = raw !== null && typeof raw === 'object' && 'ok' in raw ? (raw['ok'] === true ? raw['value'] : undefined) : raw;
  if (value === undefined || value === null) return undefined;
  const selection = value['selection'] ?? {};
  const providerId = typeof selection.providerId === 'string' ? selection.providerId : undefined;
  const language = typeof selection.language === 'string' ? selection.language : 'auto';
  const provider = Array.isArray(value['providers']) ? value['providers'].find((candidate: any) => candidate?.id === providerId) : undefined;
  const ready = providerId !== undefined && provider?.preparation?.phase === 'ready';
  return {
    ready,
    ...(providerId === undefined ? {} : { providerId }),
    language,
    maxDurationSeconds: typeof value['maxDurationSeconds'] === 'number' ? value['maxDurationSeconds'] : 120,
    maxAudioBytes: typeof value['maxAudioBytes'] === 'number' ? value['maxAudioBytes'] : 8 * 1024 * 1024,
  };
}

/** Canonical 16 kHz mono PCM16 WAV, the format the Harness speech service accepts. */
export function encodeWave(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string): void => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

export interface Recording {
  stop: () => Promise<Uint8Array>;
  cancel: () => void;
  /** 0..1 microphone level, for the recording indicator. */
  level: () => number;
}

/** Start recording from the microphone; resolves once capture runs. */
export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.addEventListener('dataavailable', (event) => { if (event.data.size > 0) chunks.push(event.data); });
  const meterContext = new AudioContext();
  const analyser = meterContext.createAnalyser();
  analyser.fftSize = 256;
  meterContext.createMediaStreamSource(stream).connect(analyser);
  const buffer = new Uint8Array(analyser.fftSize);
  const release = (): void => {
    for (const track of stream.getTracks()) track.stop();
    void meterContext.close().catch(() => undefined);
  };
  recorder.start(250);
  return {
    level: () => {
      analyser.getByteTimeDomainData(buffer);
      let peak = 0;
      for (const value of buffer) peak = Math.max(peak, Math.abs(value - 128));
      return Math.min(1, peak / 64);
    },
    cancel: () => {
      try { recorder.stop(); } catch { /* already stopped */ }
      release();
    },
    stop: () => new Promise<Uint8Array>((resolve, reject) => {
      recorder.addEventListener('stop', () => {
        release();
        void (async () => {
          try {
            const blob = new Blob(chunks, { type: recorder.mimeType });
            // Decode offline: an AudioContext per dictation would leak (browsers cap live contexts).
            const decoded = await new OfflineAudioContext(1, 1, 16_000).decodeAudioData(await blob.arrayBuffer());
            // Resample to 16 kHz mono natively, as the local voice input does.
            const frames = Math.max(1, Math.ceil(decoded.duration * 16_000));
            const offline = new OfflineAudioContext(1, frames, 16_000);
            const source = offline.createBufferSource();
            source.buffer = decoded;
            source.connect(offline.destination);
            source.start();
            const rendered = await offline.startRendering();
            resolve(encodeWave(rendered.getChannelData(0)));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      }, { once: true });
      try { recorder.stop(); } catch (error) { release(); reject(error instanceof Error ? error : new Error(String(error))); }
    }),
  };
}

/** Transcribe a WAV recording with this computer's speech service. */
export async function transcribe(speech: SpeechService, readiness: VoiceReadiness, wave: Uint8Array, signal?: AbortSignal): Promise<string> {
  if (typeof speech.transcribe !== 'function' || readiness.providerId === undefined) throw new Error('Voice input is not ready on this computer.');
  if (wave.byteLength > readiness.maxAudioBytes) throw new Error('That recording is too long. Try a shorter one.');
  const raw = (await speech.transcribe({ audioBase64: toBase64(wave), providerId: readiness.providerId, language: readiness.language ?? 'auto' }, signal)) as Record<string, any>;
  const result = raw !== null && typeof raw === 'object' && 'ok' in raw ? raw : { ok: true, value: raw };
  if (result['ok'] !== true) throw new Error(typeof result['error']?.message === 'string' ? result['error'].message : 'Voice input could not transcribe that.');
  return typeof result['value']?.text === 'string' ? result['value'].text : '';
}
