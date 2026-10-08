import { round2 } from './money.js';

const pounds = (n) => `£${Number(n).toFixed(2)}`;
const ukDate = (d) => { const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`; };

// Email notifications. Opt-in: nothing is ever sent unless the person turned them on in My orders, and only to the email their handle is linked to.
// A failed email must never break the thing that caused it, so every send swallows (and logs) its own errors; callers fire it after their change is saved.
export function createNotifier({ pool, mailer, cfg }) {
  const inflight = new Set();
  const myOrders = `${cfg.publicUrl}/my.html`;
  const footer = `\n\n—\nYou're getting this because you turned on email notifications for your orders. You can turn them off any time: ${myOrders}#/notifications`;

  function deliver(to, subject, text) {
    const p = (async () => { try { await mailer.send({ to, subject, text: text + footer }); return true; } catch (e) { console.error('notification email failed:', e.message); return false; } })();
    inflight.add(p); p.finally(() => inflight.delete(p));
    return p;
  }
  // Wraps a trigger so it can never throw into the caller; returns a promise (tests await idle(), servers just let it run).
  const safe = (fn) => (...args) => { const p = (async () => { try { await fn(...args); } catch (e) { console.error('notification failed:', e.message); } })(); inflight.add(p); p.finally(() => inflight.delete(p)); return p; };

  async function recipient(joinerId) {
    const [[r]] = await pool.query('SELECT j.instagram_handle AS handle, a.email FROM joiners j JOIN accounts a ON a.id = j.account_id WHERE j.id = ? AND a.notify_email = 1', [joinerId]);
    return r || null;
  }
  async function owedNow(joinerId) {
    const [[r]] = await pool.query("SELECT COALESCE(SUM(cc.cost - cc.paid), 0) AS n FROM claim_costs cc JOIN claims c ON c.id = cc.claim_id WHERE c.joiner_id = ? AND c.status = 'confirmed' AND cc.cost > cc.paid", [joinerId]);
    return round2(r.n);
  }
  async function creditNow(joinerId) {
    const [[r]] = await pool.query('SELECT COALESCE(SUM(balance_effect), 0) AS n FROM credit_ledger WHERE joiner_id = ?', [joinerId]);
    return round2(r.n);
  }

  // 1. Claims were secured: what's now confirmed, and what they owe in total.
  const claimsSecured = safe(async (claimIds) => {
    if (!claimIds?.length) return;
    const [rows] = await pool.query(
      `SELECT c.joiner_id AS joinerId, c.label, (SELECT COALESCE(SUM(cost), 0) FROM claim_costs WHERE claim_id = c.id) AS cost FROM claims c WHERE c.id IN (?) AND c.status = 'confirmed' ORDER BY c.joiner_id, c.id`, [claimIds]);
    for (const joinerId of [...new Set(rows.map((r) => r.joinerId))]) {
      const to = await recipient(joinerId); if (!to) continue;
      const mine = rows.filter((r) => r.joinerId === joinerId);
      const owed = await owedNow(joinerId);
      const lines = mine.map((r) => `  • ${r.label} — ${pounds(r.cost)}`).join('\n');
      await deliver(to.email, `Your order is confirmed (@${to.handle})`,
        `Hi @${to.handle},\n\nGood news — ${mine.length === 1 ? 'this claim is' : 'these claims are'} now secured:\n\n${lines}\n\n${owed > 0 ? `You now owe ${pounds(owed)} in total across your orders.` : 'Nothing is owing right now.'}\n\nSee what you owe and how to pay: ${myOrders}#/pay`);
    }
  });

  // 2. A payment was verified or rejected.
  const paymentDecided = safe(async (paymentId) => {
    const [[p]] = await pool.query('SELECT joiner_id AS joinerId, amount, method, reference, status FROM payments WHERE id = ?', [paymentId]);
    if (!p || !['confirmed', 'rejected'].includes(p.status)) return;
    const to = await recipient(p.joinerId); if (!to) return;
    const what = `${pounds(p.amount)} via ${p.method}${p.reference ? ` (ref: ${p.reference})` : ''}`;
    if (p.status === 'confirmed') {
      const [owed, credit] = [await owedNow(p.joinerId), await creditNow(p.joinerId)];
      await deliver(to.email, `Payment received — thank you (@${to.handle})`,
        `Hi @${to.handle},\n\nYour payment of ${what} has been verified — thank you!\n\n${owed > 0 ? `You still owe ${pounds(owed)}.` : "You're all paid up."}${credit > 0 ? ` You have ${pounds(credit)} credit on your account.` : ''}\n\nSee your orders: ${myOrders}`);
    } else {
      await deliver(to.email, `We couldn't verify your payment (@${to.handle})`,
        `Hi @${to.handle},\n\nWe weren't able to verify your payment of ${what}, so it hasn't been applied to your orders.\n\nIf you've sent it, please get in touch with us and we'll sort it out. You can also record a payment again: ${myOrders}#/pay`);
    }
  });

  // 3. A parcel was shipped.
  // "@a", "@a and @b", "@a, @b and @c"
  const names = (hs) => { const t = hs.map((h) => `@${h}`); return t.length <= 1 ? t.join('') : `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}`; };

  // Shipped: everyone with items in the parcel is told. For a shared parcel the recipient is asked to press "It's arrived" (for everyone), and each friend is told it's on its way to the recipient.
  const parcelShipped = safe(async (parcelId) => {
    const [[p]] = await pool.query('SELECT joiner_id AS joinerId, method, shipped_date AS shipped FROM parcels WHERE id = ?', [parcelId]);
    if (!p) return;
    const [mine] = await pool.query('SELECT c.joiner_id AS joinerId, j.instagram_handle AS handle, COUNT(*) AS n FROM parcel_items pi JOIN claims c ON c.id = pi.claim_id JOIN joiners j ON j.id = c.joiner_id WHERE pi.parcel_id = ? GROUP BY c.joiner_id, j.instagram_handle ORDER BY c.joiner_id', [parcelId]);
    const shared = mine.length > 1, on = p.shipped ? ` on ${ukDate(p.shipped)}` : '';
    const rcpt = mine.find((x) => x.joinerId === p.joinerId)?.handle;
    for (const m of mine) {
      const to = await recipient(m.joinerId); if (!to) continue;
      const items = `${m.n} item${m.n === 1 ? '' : 's'}`;
      const others = mine.filter((x) => x.joinerId !== m.joinerId).map((x) => x.handle);
      if (!shared) {
        await deliver(to.email, `Your parcel is on its way (@${to.handle})`,
          `Hi @${to.handle},\n\nYour parcel (${items}, ${p.method}) has been shipped${on}.\n\nWhen it arrives, please press "It's arrived" in My orders so we know it got to you: ${myOrders}#/ongoing`);
      } else if (m.joinerId === p.joinerId) {
        await deliver(to.email, `Your parcel is on its way (@${to.handle})`,
          `Hi @${to.handle},\n\nYour parcel (${items}, ${p.method}) has been shipped${on}. It's shared with ${names(others)}, whose items are in the same parcel.\n\nWhen it arrives, please press "It's arrived" in My orders — that confirms it for all of you: ${myOrders}#/ongoing`);
      } else {
        const also = others.filter((h) => h !== rcpt);
        await deliver(to.email, `Your items are on their way (@${to.handle})`,
          `Hi @${to.handle},\n\nYour ${items} ${m.n === 1 ? 'has' : 'have'} been shipped${on}, in a parcel with @${rcpt}'s items${also.length ? ` (and ${names(also)}'s)` : ''} to @${rcpt}'s address (${p.method}).\n\n@${rcpt} will confirm when it arrives. You can follow it in My orders: ${myOrders}#/ongoing`);
      }
    }
  });

  // Friends have been asked to share someone's parcel (all the ones still waiting to answer, or just the people named).
  const companionInvited = safe(async (parcelId, friendIds = null) => {
    const [rows] = await pool.query("SELECT pc.joiner_id AS friendId, p.joiner_id AS recipientId FROM parcel_companions pc JOIN parcels p ON p.id = pc.parcel_id WHERE pc.parcel_id = ? AND pc.status = 'invited'", [parcelId]);
    for (const c of rows.filter((r) => !friendIds || friendIds.includes(r.friendId))) {
      const to = await recipient(c.friendId); if (!to) continue;
      const [[r]] = await pool.query('SELECT instagram_handle AS h FROM joiners WHERE id = ?', [c.recipientId]);
      await deliver(to.email, `@${r.h} would like to ship together with you`,
        `Hi @${to.handle},\n\n@${r.h} has asked to ship their parcel together with yours — one parcel to their address. Nothing happens unless you say yes: you choose which of your items go in, and you can decline.\n\nPlease look at it in My orders: ${myOrders}#/ship`);
    }
  });

  // The GOM has answered a joiner's request to cancel an item.
  const cancelDecided = safe(async (requestId) => {
    const [[r]] = await pool.query('SELECT r.status, r.decision_note AS note, r.kept, r.refunded, c.label, c.joiner_id AS joinerId FROM cancel_requests r JOIN claims c ON c.id = r.claim_id WHERE r.id = ?', [requestId]);
    if (!r || !['approved', 'declined'].includes(r.status)) return;
    const to = await recipient(r.joinerId); if (!to) return;
    const note = r.note ? `\n\nMessage from the GOM: ${r.note}` : '';
    if (r.status === 'declined') {
      await deliver(to.email, `Your cancellation request wasn't approved (@${to.handle})`,
        `Hi @${to.handle},\n\nThe GOM hasn't approved your request to cancel "${r.label}", so it stays as it was.${note}\n\nYou can see it in My orders: ${myOrders}#/ongoing`);
      return;
    }
    const money = Number(r.refunded) > 0 ? `${pounds(r.refunded)} has been returned to your account as credit.` : "You hadn't paid anything towards it, so there's nothing to return.";
    const fee = Number(r.kept) > 0 ? ` ${pounds(r.kept)} was kept as a cancellation fee.` : '';
    await deliver(to.email, `Your cancellation was approved (@${to.handle})`,
      `Hi @${to.handle},\n\nThe GOM has approved your request to cancel "${r.label}". ${money}${fee}${note}\n\nYou can see your credit in My orders: ${myOrders}`);
  });

  // 4. ONE reminder per overdue claim, after its pay-by date. A claim already reminded is never reminded again. The log row is claimed BEFORE sending
  // (so two runs at once can't both email) and released if sending fails (so the next run tries again).
  async function sendOverdueReminders() {
    const [rows] = await pool.query(
      `SELECT c.id AS claimId, c.joiner_id AS joinerId, c.label, COALESCE(c.pay_by, i.payment_deadline, go.payment_deadline) AS due,
              (SELECT COALESCE(SUM(cc.cost - cc.paid), 0) FROM claim_costs cc WHERE cc.claim_id = c.id AND cc.cost > cc.paid) AS owed
         FROM claims c JOIN joiners j ON j.id = c.joiner_id JOIN accounts a ON a.id = j.account_id AND a.notify_email = 1
         LEFT JOIN items i ON i.id = c.item_id LEFT JOIN group_orders go ON go.id = c.order_id
        WHERE c.status = 'confirmed' AND COALESCE(c.pay_by, i.payment_deadline, go.payment_deadline) < CURDATE()
          AND NOT EXISTS (SELECT 1 FROM notification_log n WHERE n.kind = 'overdue_reminder' AND n.ref_id = c.id)
       HAVING owed > 0 ORDER BY c.joiner_id, c.id`);
    let emails = 0, claims = 0;
    for (const joinerId of [...new Set(rows.map((r) => r.joinerId))]) {
      const mine = [];
      for (const r of rows.filter((x) => x.joinerId === joinerId)) {
        const [ins] = await pool.query("INSERT IGNORE INTO notification_log (joiner_id, kind, ref_id) VALUES (?, 'overdue_reminder', ?)", [joinerId, r.claimId]);
        if (ins.affectedRows === 1) mine.push(r);
      }
      if (!mine.length) continue;
      const to = await recipient(joinerId);
      const ok = to && await deliver(to.email, `A friendly reminder: payment is overdue (@${to.handle})`,
        `Hi @${to.handle},\n\nJust a friendly reminder — ${mine.length === 1 ? 'this item is' : 'these items are'} past the pay-by date:\n\n${mine.map((r) => `  • ${r.label} — ${pounds(r.owed)} still to pay (was due ${ukDate(r.due)})`).join('\n')}\n\nIf you've already paid, thank you — it may just not have been checked yet. Otherwise you can pay here: ${myOrders}#/pay\n\nThis is the only reminder we'll send for these items.`);
      if (!ok) { await pool.query("DELETE FROM notification_log WHERE kind = 'overdue_reminder' AND ref_id IN (?)", [mine.map((r) => r.claimId)]); continue; }
      emails += 1; claims += mine.length;
    }
    return { emails, claims };
  }

  return { claimsSecured, paymentDecided, parcelShipped, companionInvited, cancelDecided, sendOverdueReminders, idle: async () => { while (inflight.size) await Promise.allSettled([...inflight]); } };
}
