import { conflict } from '../errors.js';
import { splitAmount } from './money.js';

// Typical weights (grams) by size bucket, used when an item has no exact weight. Midpoints of each range (XL is a guess past 500g).
export const SIZE_WEIGHTS = { XS: 25, S: 75, M: 175, L: 375, XL: 750 };
const bucket = (size) => SIZE_WEIGHTS[size] ?? SIZE_WEIGHTS.M;

// Works out the weight each item counts for in an EMS split.
//   items:    [{ id, weight (grams or null), size }]
//   boxTotal: what the whole box weighed (0/null if unknown)
// Items with an exact weight use it. Items without one share whatever is left of the box's real weight, in proportion to
// their size estimates — so the split reflects the real box without every single item needing to be weighed.
export function resolveBoxWeights(items, boxTotal = 0) {
  const weights = {};
  const known = items.filter((i) => i.weight), unknown = items.filter((i) => !i.weight);
  const knownSum = known.reduce((s, i) => s + i.weight, 0);
  const bucketSum = unknown.reduce((s, i) => s + bucket(i.size), 0);
  known.forEach((i) => { weights[i.id] = i.weight; });
  let note = '';
  if (boxTotal > 0 && unknown.length > 0) {
    const remaining = boxTotal - knownSum;
    if (remaining > 0) {
      unknown.forEach((i) => { weights[i.id] = (remaining * bucket(i.size)) / bucketSum; });
      note = `Box weighs ${boxTotal}g${known.length ? `; ${knownSum}g comes from items with exact weights, so` : ' —'} the other ${Math.round(remaining)}g is shared across ${unknown.length} item${unknown.length === 1 ? '' : 's'} by size.`;
    } else {
      unknown.forEach((i) => { weights[i.id] = bucket(i.size); });
      note = `⚠ Items with exact weights already add up to ${knownSum}g, more than the ${boxTotal}g box — the rest fall back to size estimates.`;
    }
  } else {
    unknown.forEach((i) => { weights[i.id] = bucket(i.size); });
    if (boxTotal > 0 && Math.abs(knownSum - boxTotal) > 1) note = `Heads up: item weights add up to ${knownSum}g but the box weighs ${boxTotal}g.`;
    else if (unknown.length > 0) note = 'No box weight entered — using size estimates for items without an exact weight.';
  }
  return { weights, note };
}

// The whole split for a box. EMS follows weight; customs follows item value (price). Every share is a whole number of pennies
// and each set of shares adds back to exactly the total. `items` are used in the order given.
//   items: [{ id, weight, size, price }]
// CUSTOMS follows each item's VALUE. An item that carries no customs (noCustoms) gets nothing and the others take its share. If none of the items that CAN carry it has a value, it is shared equally among them rather than lost.
// If NO item can carry it, there is nowhere for the money to go — refuse (splitAmount would quietly drop it).
export function splitCustoms(items, customsTotal) {
  const prices = items.map((i) => (i.noCustoms ? 0 : i.price));
  let weights = prices;
  if (customsTotal > 0 && prices.every((p) => !(p > 0))) {
    weights = items.map((i) => (i.noCustoms ? 0 : 1));
    if (weights.every((w) => w === 0)) throw conflict('Every item in this box is set to carry no customs — untick at least one, or the customs has nowhere to go.', 'no_customs_carrier');
  }
  return splitAmount(customsTotal, weights);
}

// EMS follows each item's WEIGHT; an item that carries no EMS (noEms) gets nothing and the others take its share.
export function boxSplit(items, { emsTotal = 0, customsTotal = 0, boxTotal = 0 } = {}) {
  const { weights, note } = resolveBoxWeights(items, boxTotal);
  const emsWeights = items.map((i) => (i.noEms ? 0 : weights[i.id]));
  if (emsTotal > 0 && emsWeights.every((w) => !(w > 0))) throw conflict('Every item in this box is set to carry no EMS — untick at least one, or the EMS has nowhere to go.', 'no_ems_carrier');
  return { weights, note, emsShares: splitAmount(emsTotal, emsWeights), customsShares: splitCustoms(items, customsTotal) };
}
