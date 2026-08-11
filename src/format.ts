/** Shared display formatting used across screens/components. */

/** Compact token counts: 128000 -> "128k", 950 -> "950". */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  const thousands = n / 1000;
  return `${thousands % 1 === 0 ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
}

/**
 * Elapsed time, compact: 340 -> "0.3s", 4312 -> "4.3s", 72400 -> "1m 12s".
 * Floored at "0.1s" so a tool that returns instantly still reads as time spent
 * rather than as "0.0s", which looks like a bug.
 */
export function formatDuration(ms: number): string {
  // Round to the displayed precision *first*, so the rollover is decided on the
  // number the user will actually read — otherwise 59.96s renders as "60.0s"
  // and 119.6s as "1m 60s".
  const tenths = Math.max(1, Math.round(ms / 100));
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(tenths / 10);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Dollar amount, with more precision for sub-cent values. */
export function formatDollars(amount: number): string {
  return `$${amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2)}`;
}
