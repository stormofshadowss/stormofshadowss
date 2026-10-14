// When does something stop taking claims? A group order closes when the GOM sets it to Closed, OR after its closing date. An item closes when the GOM closes it by hand,
// OR after its own closing date; and when its group order closes, so does everything in it.
// "After the date" means from the start of the NEXT day, in UK time (so an order closing "on the 20th" takes claims all through the 20th).
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
export const todayUK = (now = new Date()) => fmt.format(now);                          // 'YYYY-MM-DD'
export const dayOf = (d) => (d ? String(d).slice(0, 10) : null);
export const datePassed = (d, today = todayUK()) => !!d && dayOf(d) < today;
export const ukDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

// Why (if at all) is this closed to joiners? → null | 'order_hand' | 'order_date' | 'item_hand' | 'item_date'
export function closedReason({ orderStatus, orderCloseDate, itemCloseDate, itemClosedByHand }, today = todayUK()) {
  if (orderStatus !== 'open') return 'order_hand';
  if (datePassed(orderCloseDate, today)) return 'order_date';
  if (itemClosedByHand) return 'item_hand';
  if (datePassed(itemCloseDate, today)) return 'item_date';
  return null;
}
