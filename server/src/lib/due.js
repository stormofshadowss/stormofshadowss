import { todayUK } from './closing.js';

// WHEN IS A COST LINE DUE? The item cost follows the claim's pay-by date (its own, else the item's, else the group order's). A FEE — EMS, customs, postage, packaging — has its OWN due date, picked by the
// GOM when the fee is added (none = never overdue). "Overdue" is worked out LINE by LINE, so a fee added today can never be overdue because of an old item date.
export const FEE_CATS = ['ems', 'customs', 'doms', 'packaging'];
export const FEE_DUE_DAYS = 14;                                                     // only used when a fee is raised WITHOUT a date (the GOM's screens always ask)
// as SQL: needs claim_costs as cc, claims as c, items as i, group_orders as go
export const LINE_DUE = "CASE WHEN cc.category = 'initials' THEN COALESCE(c.pay_by, i.payment_deadline, go.payment_deadline) ELSE cc.due_date END";

export const addDaysYMD = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const daysBetweenYMD = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
export const defaultFeeDue = () => addDaysYMD(todayUK(), FEE_DUE_DAYS);

// After a fee line was RAISED: an explicit date always wins; otherwise it keeps the date it already has; otherwise it gets the default.
export async function stampFeeDue(conn, claimId, category, dueDate) {
  if (!FEE_CATS.includes(category)) return;
  await conn.query('UPDATE claim_costs SET due_date = COALESCE(?, due_date, ?) WHERE claim_id = ? AND category = ?', [dueDate || null, defaultFeeDue(), claimId, category]);
}
