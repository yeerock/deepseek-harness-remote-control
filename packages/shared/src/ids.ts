import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Lowercase base32 without padding: URL-safe, case-insensitive, log-safe. */
export function base32(bytes: Uint8Array): string {
  let value = 0;
  let bits = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

/** `dev_` + 20 lowercase base32 chars (100 bits). */
export function newDeviceId(): string {
  return `dev_${base32(randomBytes(13)).slice(0, 20)}`;
}

export function newId(prefix: string, bytes = 12): string {
  return `${prefix}_${base32(randomBytes(bytes)).slice(0, 22)}`;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison of two UTF-8 strings. */
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* --------------------------- signed blobs --------------------------- */

/** `payloadBase64url.signatureBase64url`. Used for cookies and hop tokens. */
export function signPayload(secret: string, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${signBody(secret, body)}`;
}

function signBody(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/**
 * Verify and decode a signed blob. Returns `undefined` for any tampering,
 * malformed input, or expiry (`exp` seconds since epoch, optional).
 */
export function verifyPayload<T>(secret: string, value: string, nowSeconds = Math.floor(Date.now() / 1000)): T | undefined {
  const dot = value.lastIndexOf('.');
  if (dot <= 0 || dot === value.length - 1) return undefined;
  const body = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const expected = signBody(secret, body);
  if (!safeEqual(signature, expected)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const exp = (parsed as { exp?: unknown }).exp;
  if (typeof exp === 'number' && exp <= nowSeconds) return undefined;
  return parsed as T;
}

/* ---------------------------- pair codes ---------------------------- */

/** Ambiguous glyphs (0/O, 1/I/L) are excluded: these are read aloud. */
const PAIR_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

/** 8 characters, rendered as `abcd-efgh` (32 bits, 10-minute TTL). */
export function newPairCode(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (const byte of bytes) out += PAIR_ALPHABET[byte % PAIR_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export function normalizePairCode(input: string): string | undefined {
  const cleaned = input.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (cleaned.length !== 8) return undefined;
  for (const char of cleaned) if (!PAIR_ALPHABET.includes(char)) return undefined;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}

/** Hash a pair code for storage; the code itself is never persisted. */
export function pairCodeHash(code: string): string {
  return sha256Hex(`pair:${normalizePairCode(code) ?? code}`);
}

/** Constant-time check that a bearer token matches a stored hash. */
export function tokenMatchesHash(token: string, storedHash: string): boolean {
  return safeEqual(sha256Hex(token), storedHash);
}