export type BackoffOptions = {
  baseMs?: number;
  maxMs?: number;
  jitter?: number;
  rng?: () => number;
};

export function computeBackoffMs(attempt: number, options: BackoffOptions = {}) {
  const baseMs = options.baseMs ?? 500;
  const maxMs = options.maxMs ?? 10_000;
  const jitter = options.jitter ?? 0.2;
  const rng = options.rng ?? Math.random;

  const exp = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  const rand = rng();
  const jitterRange = exp * jitter;
  const jittered = exp - jitterRange + rand * (jitterRange * 2);
  return Math.max(0, Math.round(jittered));
}
