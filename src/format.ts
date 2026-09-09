/** Compact token counts: 128000 -> "128k", 950 -> "950". */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  const thousands = n / 1000;
  return `${thousands % 1 === 0 ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
}

/** Compact elapsed time, floored at 0.1s to avoid displaying instant work as 0.0s. */
export function formatDuration(ms: number): string {
  // Round before rollover to avoid "60.0s" or "1m 60s".
  const tenths = Math.max(1, Math.round(ms / 100));
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(tenths / 10);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatDollars(amount: number): string {
  return `$${amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2)}`;
}
