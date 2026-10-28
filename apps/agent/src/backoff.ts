/**
 * Full-jitter exponential backoff (PROTOCOL.md §4.6): base 250 ms, cap 20 s,
 * multiplier 2. Full jitter means the delay is drawn uniformly from
 * `[0, min(cap, base * 2^attempt))`, which de-synchronises a fleet of agents
 * after an edge restart.
 */

export const BACKOFF_BASE_MS = 250;
export const BACKOFF_CAP_MS = 20_000;

export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  /** Injectable for deterministic tests. Must return [0, 1). */
  random?: () => number;
}

/** Delay before retry `attempt` (0-based). Never negative, never above the cap. */
export function fullJitterDelay(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? BACKOFF_BASE_MS;
  const capMs = options.capMs ?? BACKOFF_CAP_MS;
  const random = options.random ?? Math.random;
  const exponent = Math.max(0, Math.floor(attempt));
  const ceiling = Math.min(capMs, baseMs * 2 ** exponent);
  const value = Math.floor(random() * ceiling);
  return Math.max(0, value);
}