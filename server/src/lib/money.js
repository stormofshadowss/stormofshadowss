export const CATS = ['initials', 'ems', 'customs', 'doms', 'packaging'];
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Splits a total across weights in whole pennies, so the shares always add
// back up to exactly the total (any leftover pennies go to the biggest shares).
export function splitAmount(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!total || sum <= 0) return weights.map(() => 0);
  const cents = weights.map((w) => Math.round((total * w) / sum * 100));
  let diff = Math.round(total * 100) - cents.reduce((a, b) => a + b, 0);
  const order = weights.map((_, i) => i).sort((a, b) => weights[b] - weights[a]);
  for (let k = 0; diff !== 0; k++) {
    cents[order[k % order.length]] += diff > 0 ? 1 : -1;
    diff += diff > 0 ? -1 : 1;
  }
  return cents.map((c) => c / 100);
}
