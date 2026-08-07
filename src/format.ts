/** Shared display formatting used across screens/components. */

/** Compact token counts: 128000 -> "128k", 950 -> "950". */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  const thousands = n / 1000;
  return `${thousands % 1 === 0 ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
}

/** Dollar amount, with more precision for sub-cent values. */
export function formatDollars(amount: number): string {
  return `$${amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2)}`;
}
