/**
 * DSH RC tunnel protocol v1 — frame constants, codec, and schema guards.
 *
 * This module is the single source of truth for both peers. Anything that must
 * agree on the wire lives here; anything that is policy lives in the edge or
 * the agent. See docs/PROTOCOL.md for the normative description.
 */

export const PROTOCOL_VERSION = 1;

/** Total frame ceiling including the 5-byte header. */
export const MAX_FRAME_BYTES = 64 * 1024;
/** Payload ceiling for one DATA frame. */
export const DATA_CHUNK_BYTES = 32 * 1024;
/** Hard ceiling for a JSON control payload. */
export const MAX_CONTROL_BYTES = 32 * 1024;

export const INITIAL_STREAM_WINDOW = 256 * 1024;
export const INITIAL_CONNECTION_WINDOW = 8 * 1024 * 1024;
/** A receiver grants more credit once this much of its window was consumed. */
export const WINDOW_UPDATE_THRESHOLD = 128 * 1024;
export const INITIAL_WINDOW_GRANT = INITIAL_STREAM_WINDOW;

export const DEFAULT_HEARTBEAT_MS = 15_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
export const DEFAULT_WS_OPEN_TIMEOUT_MS = 10_000;

export const MAX_CONCURRENT_STREAMS = 256;
export const MAX_WS_STREAM_BUDGET_BYTES = 64 * 1024 * 1024;

/** Close codes used by the edge and agent. 4000-4999 is the application range. */
export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  ProtocolError: 1002,
  UnsupportedData: 1003,
  PolicyViolation: 1008,
  InternalError: 1011,
  HeartbeatTimeout: 4000,
  ProtocolMismatch: 4001,
  AuthFailed: 4002,
  DeviceRevoked: 4003,
  TunnelReplaced: 4004,
  ServerDraining: 4005,
} as const;
export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode];

export const FrameType = {
  Hello: 1,
  HelloAck: 2,
  Ping: 3,
  Pong: 4,
  Open: 5,
  Head: 6,
  Data: 7,
  End: 8,
  Reset: 9,
  Window: 10,
  WsFrame: 11,
  GoAway: 12,
  OpenAck: 13,
} as const;
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

const KNOWN_TYPES = new Set<number>(Object.values(FrameType));

export const HEADER_BYTES = 5;

export class ProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export interface Frame {
  type: FrameTypeValue;
  streamId: number;
  payload: Uint8Array;
}

/** Encode one tunnel frame. Throws rather than emitting an oversized frame. */
export function encodeFrame(type: FrameTypeValue, streamId: number, payload?: Uint8Array): Uint8Array {
  if (!KNOWN_TYPES.has(type)) throw new ProtocolError('PROTOCOL_BAD_FRAME', `unknown frame type ${String(type)}`);
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffff_ffff) {
    throw new ProtocolError('PROTOCOL_BAD_FRAME', `streamId out of range: ${String(streamId)}`);
  }
  const body = payload ?? EMPTY;
  const total = HEADER_BYTES + body.byteLength;
  if (total > MAX_FRAME_BYTES) {
    throw new ProtocolError('PROTOCOL_BAD_FRAME', `frame of ${String(total)} bytes exceeds ${String(MAX_FRAME_BYTES)}`);
  }
  const out = new Uint8Array(total);
  out[0] = type;
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(1, streamId, false);
  out.set(body, HEADER_BYTES);
  return out;
}

/** Decode one tunnel frame, validating type and declared length. */
export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.byteLength < HEADER_BYTES) {
    throw new ProtocolError('PROTOCOL_BAD_FRAME', `frame shorter than ${String(HEADER_BYTES)} bytes`);
  }
  if (bytes.byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolError('PROTOCOL_BAD_FRAME', `frame of ${String(bytes.byteLength)} bytes exceeds ${String(MAX_FRAME_BYTES)}`);
  }
  const type = bytes[0] as number;
  if (!KNOWN_TYPES.has(type)) throw new ProtocolError('PROTOCOL_BAD_FRAME', `unknown frame type ${String(type)}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const streamId = view.getUint32(1, false);
  return { type: type as FrameTypeValue, streamId, payload: bytes.subarray(HEADER_BYTES) };
}

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeJson(value: unknown): Uint8Array {
  const text = JSON.stringify(value);
  const bytes = encoder.encode(text);
  if (bytes.byteLength > MAX_CONTROL_BYTES) {
    throw new ProtocolError('PROTOCOL_BAD_FRAME', `control payload of ${String(bytes.byteLength)} bytes exceeds ${String(MAX_CONTROL_BYTES)}`);
  }
  return bytes;
}

export function decodeJson<T>(payload: Uint8Array, guard: (value: unknown) => value is T): T {
  if (payload.byteLength === 0) throw new ProtocolError('PROTOCOL_BAD_FRAME', 'empty JSON payload');
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payload));
  } catch {
    throw new ProtocolError('PROTOCOL_BAD_FRAME', 'control payload is not valid JSON');
  }
  if (!guard(parsed)) throw new ProtocolError('PROTOCOL_BAD_FRAME', 'control payload failed schema validation');
  return parsed;
}

export function encodeUint32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new ProtocolError('PROTOCOL_BAD_FRAME', `uint32 out of range: ${String(value)}`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

export function decodeUint32(payload: Uint8Array): number {
  if (payload.byteLength !== 4) throw new ProtocolError('PROTOCOL_BAD_FRAME', 'WINDOW payload must be 4 bytes');
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, false);
}

export function encodeTimestamp(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(Math.max(0, Math.trunc(value))), false);
  return out;
}

export function decodeTimestamp(payload: Uint8Array): number {
  if (payload.byteLength !== 8) throw new ProtocolError('PROTOCOL_BAD_FRAME', 'PING payload must be 8 bytes');
  return Number(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigUint64(0, false));
}

/* ------------------------------------------------------------------ */
/* Payload shapes                                                      */
/* ------------------------------------------------------------------ */

export type HeaderPair = readonly [name: string, value: string];
export type Priority = 'high' | 'normal' | 'low';
export type StreamKind = 'http' | 'ws';

export interface Hello {
  protocol: number;
  deviceId: string;
  token: string;
  agentVersion: string;
  platform: string;
  maxFrameBytes: number;
}

export type HelloAck =
  | {
      ok: true;
      protocol: number;
      edgeId: string;
      serverTime: number;
      heartbeatMs: number;
      idleTimeoutMs: number;
      initialStreamWindow: number;
      initialConnectionWindow: number;
      maxFrameBytes: number;
    }
  | { ok: false; code: string; message: string };

export interface Open {
  kind: StreamKind;
  method: string;
  path: string;
  headers: HeaderPair[];
  priority: Priority;
  /** Present for observability only; never used for routing. */
  requestId?: string;
}

export interface OpenAck {
  ok: boolean;
  /** HTTP status for an upstream WS handshake rejection. */
  status?: number;
  message?: string;
  /** Negotiated subprotocol, echoed to the browser. */
  protocol?: string;
}

export interface Head {
  status: number;
  statusText?: string;
  headers: HeaderPair[];
  bodyless?: boolean;
}

export interface End {
  error?: { code: string; message: string };
}

export interface Reset {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface GoAway {
  code: string;
  message: string;
  retryAfterMs?: number;
}

export const WsOpcode = {
  Text: 1,
  Binary: 2,
  Close: 8,
  Ping: 9,
  Pong: 10,
} as const;
export type WsOpcodeValue = (typeof WsOpcode)[keyof typeof WsOpcode];

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}

function isHeaders(value: unknown): value is HeaderPair[] {
  return Array.isArray(value)
    && value.length <= 512
    && value.every((pair) => Array.isArray(pair)
      && pair.length === 2
      && isString(pair[0])
      && isString(pair[1])
      && pair[0].length <= 256
      && pair[1].length <= 32 * 1024);
}

export function isHello(value: unknown): value is Hello {
  return isRecord(value)
    && value['protocol'] === PROTOCOL_VERSION
    && isString(value['deviceId']) && value['deviceId'].length <= 128
    && isString(value['token']) && value['token'].length <= 512
    && isString(value['agentVersion']) && value['agentVersion'].length <= 64
    && isString(value['platform']) && value['platform'].length <= 64
    && isFiniteInt(value['maxFrameBytes']);
}

export function isHelloAck(value: unknown): value is HelloAck {
  if (!isRecord(value) || typeof value['ok'] !== 'boolean') return false;
  if (value['ok'] === false) return isString(value['code']) && isString(value['message']);
  return value['protocol'] === PROTOCOL_VERSION
    && isString(value['edgeId'])
    && isFiniteInt(value['serverTime'])
    && isFiniteInt(value['heartbeatMs'])
    && isFiniteInt(value['idleTimeoutMs'])
    && isFiniteInt(value['initialStreamWindow'])
    && isFiniteInt(value['initialConnectionWindow'])
    && isFiniteInt(value['maxFrameBytes']);
}

const PRIORITIES = new Set<Priority>(['high', 'normal', 'low']);

export function isOpen(value: unknown): value is Open {
  if (!isRecord(value)) return false;
  const kind = value['kind'];
  const priority = value['priority'];
  return (kind === 'http' || kind === 'ws')
    && isString(value['method']) && /^[A-Z]{1,16}$/.test(value['method'])
    && isString(value['path']) && value['path'].startsWith('/') && value['path'].length <= 8192
    && isHeaders(value['headers'])
    && isString(priority) && PRIORITIES.has(priority as Priority);
}

export function isOpenAck(value: unknown): value is OpenAck {
  if (!isRecord(value) || typeof value['ok'] !== 'boolean') return false;
  if (value['status'] !== undefined && !isFiniteInt(value['status'])) return false;
  if (value['message'] !== undefined && !isString(value['message'])) return false;
  if (value['protocol'] !== undefined && !isString(value['protocol'])) return false;
  return true;
}

export function isHead(value: unknown): value is Head {
  return isRecord(value)
    && isFiniteInt(value['status']) && value['status'] >= 100 && value['status'] <= 599
    && (value['statusText'] === undefined || isString(value['statusText']))
    && isHeaders(value['headers'])
    && (value['bodyless'] === undefined || typeof value['bodyless'] === 'boolean');
}

export function isEnd(value: unknown): value is End {
  if (!isRecord(value)) return false;
  const error = value['error'];
  if (error === undefined) return true;
  return isRecord(error) && isString(error['code']) && isString(error['message']);
}

export function isReset(value: unknown): value is Reset {
  return isRecord(value)
    && isString(value['code'])
    && isString(value['message'])
    && (value['retryable'] === undefined || typeof value['retryable'] === 'boolean');
}

export function isGoAway(value: unknown): value is GoAway {
  return isRecord(value)
    && isString(value['code'])
    && isString(value['message'])
    && (value['retryAfterMs'] === undefined || isFiniteInt(value['retryAfterMs']));
}

export function encodeWsFrame(opcode: WsOpcodeValue, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + data.byteLength);
  out[0] = opcode;
  out.set(data, 1);
  return out;
}

export function decodeWsFrame(payload: Uint8Array): { opcode: WsOpcodeValue; data: Uint8Array } {
  if (payload.byteLength < 1) throw new ProtocolError('PROTOCOL_BAD_FRAME', 'WS_FRAME payload is empty');
  const opcode = payload[0] as number;
  if (opcode !== 1 && opcode !== 2 && opcode !== 8 && opcode !== 9 && opcode !== 10) {
    throw new ProtocolError('PROTOCOL_BAD_FRAME', `unsupported WebSocket opcode ${String(opcode)}`);
  }
  return { opcode: opcode as WsOpcodeValue, data: payload.subarray(1) };
}

/** Close-frame body: 2-byte big-endian code followed by UTF-8 reason. */
export function encodeCloseBody(code: number, reason: string): Uint8Array {
  const reasonBytes = encoder.encode(reason.slice(0, 120));
  const body = new Uint8Array(2 + reasonBytes.byteLength);
  new DataView(body.buffer).setUint16(0, code, false);
  body.set(reasonBytes, 2);
  return body;
}

export function decodeCloseBody(body: Uint8Array): { code: number; reason: string } {
  if (body.byteLength < 2) return { code: 1005, reason: '' };
  const code = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint16(0, false);
  return { code, reason: decoder.decode(body.subarray(2)) };
}