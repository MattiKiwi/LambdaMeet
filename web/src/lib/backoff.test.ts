import { describe, expect, it } from "vitest";
import { computeBackoffMs } from "./backoff";

describe("computeBackoffMs", () => {
  it("grows with attempts and caps at max", () => {
    const rng = () => 0.5;
    const first = computeBackoffMs(1, { baseMs: 500, maxMs: 2000, rng });
    const second = computeBackoffMs(2, { baseMs: 500, maxMs: 2000, rng });
    const third = computeBackoffMs(3, { baseMs: 500, maxMs: 2000, rng });
    const fourth = computeBackoffMs(4, { baseMs: 500, maxMs: 2000, rng });
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(fourth).toBeLessThanOrEqual(2000);
  });

  it("applies jitter within range", () => {
    const jittered = computeBackoffMs(1, { baseMs: 1000, jitter: 0.2, rng: () => 0 });
    expect(jittered).toBe(800);
  });
});
