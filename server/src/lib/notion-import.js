import { parse } from 'csv-parse/sync';
import crypto from 'node:crypto';
import { round2 } from './money.js';

// Importing a Notion "Claims" database (one row per person per item) into the site. Everything in this file is pure — it reads text and works out a PLAN
// (what would be created, and what needs a human decision) without touching the database, so the GOM can see it all before anything is saved.

export class ImportError extends Error {}

export const STAGES = ['awaiting fulfillment', 'ordered via proxy / warehouse', 'arrived at proxy / warehouse', 'shipping requested', 'enroute to GOM', 'arrived at GOM',
  'checking parcel', 'ready to pack / on hand', 'packed', 'shipped', 'completed'];
// Notion's "Order Status" → the site's stage. Anything not listed here must be mapped by the GOM before importing.
export const DEFAULT_STATUS = {
  'awaiting fulfilment': 'awaiting fulfillment', 'ordered via proxy': 'ordered via proxy / warehouse', 'ordered via warehouse': 'ordered via proxy / warehouse',
  'ordered (uk)': 'ordered via proxy / warehouse', '@ proxy': 'arrived at proxy / warehouse', 'shipping requested': 'shipping requested', 'enroute to gom': 'enroute to GOM',
  'ready to pack / on hand with gom': 'ready to pack / on hand', 'shipping to you': 'shipped', completed: 'completed',
  'cancelled - sold out': 'cancelled', 'cancelled - joiner request': 'cancelled',
};
export const CATS = ['initials', 'ems', 'customs', 'doms', 'packaging'];       // the order a payment is spread across a claim's costs (the same order the site uses)
export const REQUIRED_COLUMNS = ['Joiner', 'GO', 'Item', 'Order Status', 'Initials', 'Amount Paid'];
export const DEFAULT_GROUP = 'Imported from Notion';
export const PARCEL_METHOD = 'Shipped before the move to this site';
export const NO_ORDER_TITLE = 'Notion import — no group order named';
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const stripUrl = (s) => clean(s).replace(/\s*\(https?:\/\/[^)]*\)\s*$/, '');          // Notion writes a linked record as "Name (https://…)"
export const statusKey = (s) => clean(s).toLowerCase();

export function parseMoney(s) {
  const t = clean(s).replace(/,/g, '');
  if (!t) return null;
  const m = /^(-)?\s*£?\s*(-)?\s*(\d*\.?\d+)$/.exec(t);
  if (!m) return NaN;
  return round2((m[1] || m[2] ? -1 : 1) * Number(m[3]));
}
export function parseQty(s) { const t = clean(s); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : NaN; }
export function parseDate(s) {                                                  // "26 March 2026" → 2026-03-26
  const t = clean(s); if (!t) return null;
  const m = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(t); if (!m) return NaN;
  const mo = MONTHS[m[2].toLowerCase()], d = Number(m[1]);
  if (!mo || d < 1 || d > 31) return NaN;
  const dt = new Date(Date.UTC(Number(m[3]), mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return NaN;                                  // 31 February etc.
  return dt.toISOString().slice(0, 10);
}

export function parseNotionClaims(text) {
  let records;
  try { records = parse(text, { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true }); }
  catch (e) { throw new ImportError(`That file couldn't be read as a CSV (${e.message}).`); }
  if (!records.length) throw new ImportError('That file has no rows in it.');
  const cols = Object.keys(records[0]);
  const missing = REQUIRED_COLUMNS.filter((c) => !cols.includes(c));
  if (missing.length) throw new ImportError(`That doesn't look like the full Claims export — these columns are missing: ${missing.join(', ')}. In Notion, export the Claims database as CSV and use the file whose name ends in _all.csv.`);
  const rows = records.map((r, i) => {
    const raw = { qty: clean(r['Quantity']), initials: clean(r['Initials']), ems: clean(r['EMS']), customs: clean(r['Customs']), doms: clean(r['DOMS']), packing: clean(r['Packing fee']), paid: clean(r['Amount Paid']) };
    const bad = [];
    const money = (k) => { const v = parseMoney(raw[k]); if (Number.isNaN(v)) { bad.push(`"${raw[k]}" isn't a money amount (${k})`); return null; } return v; };
    const date = (col) => { const v = parseDate(r[col]); if (Number.isNaN(v)) { bad.push(`"${clean(r[col])}" isn't a date (${col})`); return null; } return v; };
    const qty = parseQty(raw.qty);
    if (Number.isNaN(qty)) bad.push(`"${raw.qty}" isn't a quantity`);
    return {
      n: i + 2,                                                                 // the row number in the spreadsheet (row 1 is the header)
      joiner: clean(r['Joiner']), relation: stripUrl(r['Joiners']), go: stripUrl(r['GO']), item: clean(r['Item']), status: clean(r['Order Status']),
      qty: Number.isNaN(qty) ? null : qty, initials: money('initials'), ems: money('ems'), customs: money('customs'), doms: money('doms'), packing: money('packing'), paid: money('paid'),
      initialDue: date('Initial Due Date'), readyDate: date('Ready To Pack Date'), storageDeadline: date('Storage Deadline'), raw, bad,
    };
  });
  return { rows, columns: cols };
}

// A suggested Instagram handle for whatever the GOM typed in the Joiner column. "confident" means it already is a plain handle; anything we had to tidy is flagged for a human look.
export function suggestHandle(rawText) {
  const t = clean(rawText);
  if (!t) return { handle: null, confident: false, why: 'empty' };
  if (/^@?[A-Za-z0-9._]{1,30}$/.test(t)) return { handle: t.replace(/^@/, '').toLowerCase(), confident: true, why: '' };
  const before = t.replace(/\(.*$/, '');
  const s = before.replace(/^@/, '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9._]/g, '');
  if (!s || s.length > 30) return { handle: null, confident: false, why: 'not a usable handle' };
  return { handle: s, confident: false, why: t.includes('(') ? 'has brackets — took the part before them' : 'has spaces or odd characters — tidied' };
}

const sha = (parts) => crypto.createHash('sha1').update(parts.join('\u0001')).digest('hex');
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const isHistory = (target) => target === 'completed' || target === 'cancelled';

// Spreads what a person has paid over a claim's costs in the site's own order, never more than each cost; whatever is left over is the "excess".
export function allocatePaid(costs, paid) {
  let left = round2(Math.max(0, paid || 0)); const alloc = {};
  for (const c of CATS) { const a = round2(Math.min(costs[c] || 0, left)); alloc[c] = a; left = round2(left - a); }
  return { alloc, excess: left };
}

/**
 * Works out everything an import would do.
 *   rows      what parseNotionClaims returned
 *   mapping   the GOM's decisions: { scope, people: {rawText: handle|''}, groups: {goTitle: {artistGroup}}, defaultGroup, statuses: {rawStatus: stage|'cancelled'} }
 *   existing  what the site already has: { orders: Set(lowercased titles), handles: Set, keys: Set(source keys already imported) }
 */
export function buildPlan(rows, mapping = {}, existing = {}) {
  const scope = mapping.scope || 'ongoing';
  const ex = { orders: existing.orders || new Set(), handles: existing.handles || new Set(), signedUp: existing.signedUp || new Set(), keys: existing.keys || new Set() };
  const statusMap = { ...DEFAULT_STATUS, ...Object.fromEntries(Object.entries(mapping.statuses || {}).map(([k, v]) => [statusKey(k), v])) };
  const peopleMap = mapping.people || {};
  const report = { rowsInFile: rows.length, rowsInScope: 0, skipped: { noJoiner: 0, outOfScope: 0, alreadyImported: 0, blocked: 0 }, warnings: [], blockers: { unresolvedPeople: [], unknownStatuses: [] },
    attention: { excess: [], negatives: [] }, byStage: {}, money: { due: 0, paid: 0, owed: 0, excess: 0 } };
  const warn = (n, text) => report.warnings.push({ n, text });
  const unresolved = new Map(), unknownStatus = new Map();
  const people = new Map(), orders = new Map(), claims = [], seenBase = new Map();

  for (const row of rows) {
    for (const b of row.bad) warn(row.n, b);
    const target = statusMap[statusKey(row.status)];
    if (!target) {                                                              // matched ignoring capitals and stray spaces, so one unknown status is ONE decision
      const k = statusKey(row.status) || '(blank)', e = unknownStatus.get(k) || { raw: row.status || '(blank)', count: 0 };
      e.count += 1; unknownStatus.set(k, e); report.skipped.blocked += 1; continue;
    }
    if ((scope === 'ongoing' && isHistory(target)) || (scope === 'history' && !isHistory(target))) { report.skipped.outOfScope += 1; continue; }
    report.rowsInScope += 1;
    if (!row.joiner) { report.skipped.noJoiner += 1; warn(row.n, 'no Joiner — this row was left out'); continue; }
    let handle = peopleMap[row.joiner];
    if (handle === undefined) { const sg = suggestHandle(row.joiner); handle = sg.confident ? sg.handle : null; }
    if (handle === '') { report.skipped.noJoiner += 1; continue; }                // the GOM chose to skip this person's rows
    if (!handle) { unresolved.set(row.joiner, (unresolved.get(row.joiner) || 0) + 1); report.skipped.blocked += 1; continue; }

    const goTitle = cut(row.go || NO_ORDER_TITLE, 160); if (!row.go) warn(row.n, 'no group order named — put under "' + NO_ORDER_TITLE + '"');
    const itemFull = row.item || '(no item name)'; if (!row.item) warn(row.n, 'no item name');
    let qty = row.qty;
    if (qty === null) { if (!row.bad.some((b) => /quantity/.test(b))) warn(row.n, 'no quantity — counted as 1'); qty = 1; }
    else if (qty <= 0) { warn(row.n, `quantity ${qty} — counted as 1`); qty = 1; }
    if (!Number.isInteger(qty)) warn(row.n, `fractional quantity ${qty} kept in the label as written`);
    const costs = { initials: row.initials, ems: row.ems, customs: row.customs, doms: row.doms, packaging: row.packing };
    const clamped = {}; let negative = null;
    for (const c of CATS) { const v = costs[c] ?? 0; if (v < 0) { negative = { cat: c, amount: v }; clamped[c] = 0; } else clamped[c] = v; }
    const { alloc, excess } = allocatePaid(clamped, row.paid);
    const total = round2(CATS.reduce((s, c) => s + clamped[c], 0)), paidIn = round2(CATS.reduce((s, c) => s + alloc[c], 0));
    report.money.due = round2(report.money.due + total); report.money.paid = round2(report.money.paid + paidIn); report.money.excess = round2(report.money.excess + excess);

    const base = [handle, goTitle, itemFull, row.raw.qty, row.raw.initials, row.raw.ems, row.raw.customs, row.raw.doms, row.raw.packing, row.raw.paid, row.status].join('\u0001');
    const occ = (seenBase.get(base) || 0) + 1; seenBase.set(base, occ);
    const key = sha([base, occ]);
    if (ex.keys.has(key)) { report.skipped.alreadyImported += 1; continue; }

    const suffix = qty > 1 || !Number.isInteger(qty) ? ` (×${qty})` : '';
    const label = cut(itemFull, 255 - suffix.length) + suffix;
    if (itemFull.length + suffix.length > 255) warn(row.n, 'item name was longer than 255 characters — shortened on the claim');
    if (negative) report.attention.negatives.push({ n: row.n, handle, go: goTitle, item: cut(itemFull, 60), amount: negative.amount, what: negative.cat });
    if (excess > 0.004) report.attention.excess.push({ n: row.n, handle, go: goTitle, item: cut(itemFull, 60), amount: excess });

    if (!people.has(handle)) people.set(handle, { handle, existing: ex.handles.has(handle), signedUp: ex.signedUp.has(handle), claims: 0 });
    people.get(handle).claims += 1;
    if (!orders.has(goTitle)) {
      const group = (mapping.groups?.[goTitle]?.artistGroup || mapping.defaultGroup || DEFAULT_GROUP).trim();
      orders.set(goTitle, { title: goTitle, artistGroup: cut(group, 80), existing: ex.orders.has(goTitle.toLowerCase()), items: new Map() });
    }
    const order = orders.get(goTitle);
    if (!order.items.has(itemFull)) order.items.set(itemFull, { full: itemFull, title: cut(itemFull, 160), truncated: itemFull.length > 160, prices: new Map(), sort: order.items.size });
    const it = order.items.get(itemFull);
    const unit = round2(clamped.initials / Math.max(1, qty)); it.prices.set(unit, (it.prices.get(unit) || 0) + 1);

    const confirmed = target !== 'cancelled';
    const stage = confirmed ? target : 'awaiting fulfillment';
    report.byStage[confirmed ? stage : 'cancelled'] = (report.byStage[confirmed ? stage : 'cancelled'] || 0) + 1;
    if (confirmed) report.money.owed = round2(report.money.owed + (total - paidIn));
    claims.push({ n: row.n, key, handle, goTitle, itemFull, label, status: confirmed ? 'confirmed' : 'cancelled', pipeline: stage, costs: clamped, alloc, payBy: row.initialDue, readyDate: row.readyDate, storageDeadline: row.storageDeadline });
  }
  report.blockers.unresolvedPeople = [...unresolved].map(([raw, count]) => ({ raw, count })).sort((a, b) => b.count - a.count);
  report.blockers.unknownStatuses = [...unknownStatus.values()];
  const orderList = [...orders.values()].map((o) => ({ ...o, items: [...o.items.values()].map((i) => ({ ...i, price: [...i.prices].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0] })) }));
  report.counts = {
    claims: claims.length, cancelled: claims.filter((c) => c.status === 'cancelled').length,
    people: { total: people.size, new: [...people.values()].filter((p) => !p.existing).length, existing: [...people.values()].filter((p) => p.existing).length, signedUp: [...people.values()].filter((p) => p.signedUp).length },
    orders: { total: orderList.length, new: orderList.filter((o) => !o.existing).length, existing: orderList.filter((o) => o.existing).length },
    items: orderList.reduce((s, o) => s + o.items.length, 0),
  };
  // "Shipping to you" items: one shipped parcel per person, so they can press "It's arrived" (which completes the claims) without the GOM doing it for them.
  const shipped = new Map();
  for (const c of claims) if (c.status === 'confirmed' && c.pipeline === 'shipped') { if (!shipped.has(c.handle)) shipped.set(c.handle, []); shipped.get(c.handle).push(c.key); }
  const parcels = [...shipped].map(([handle, keys]) => ({ handle, keys }));
  report.counts.parcels = { parcels: parcels.length, claims: parcels.reduce((s, p) => s + p.keys.length, 0) };
  report.ok = !report.blockers.unresolvedPeople.length && !report.blockers.unknownStatuses.length;
  return { scope, claims, orders: orderList, people: [...people.values()], parcels, report };
}
