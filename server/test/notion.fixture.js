// Builds CSV text in the shape of a Notion "Claims" export (the full, "_all" version), with made-up people and orders — never real data.
export const HEADER = ['Joiner', 'Amount Outstanding', 'Amount Paid', 'Customs', 'Customs Due Date', 'DOMS', 'DOMS Due Date', 'EMS', 'EMS Due Date', 'Fee Status', 'GO', 'Initial Due Date', 'Initials', 'Item',
  'Joiners', 'Order Status', 'Packing fee', 'Quantity', 'Ready To Pack Date', 'Storage Deadline', 'Total Due', 'Tracking number', 'is overdue', 'name needed for outstanding balance'];
const gbp = (n) => (n === null || n === undefined ? '' : `${n < 0 ? '-' : ''}£${Math.abs(n).toFixed(2)}`);
const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
let slug = 0;
export function row(o = {}) {
  const d = { joiner: 'amy_k', go: 'Run It GO', item: 'Album A', qty: 1, initials: 20, ems: null, customs: null, doms: null, packing: null, paid: null, status: 'Ordered via Proxy', initialDue: '', ready: '', storage: '', relation: null, tracking: '', ...o };
  const total = [d.initials, d.ems, d.customs, d.doms, d.packing].reduce((s, x) => s + (x || 0), 0);
  const paid = d.paid === undefined ? null : d.paid;
  const cells = {
    'Joiner': d.joiner, 'Amount Outstanding': gbp(Math.round((total - (paid || 0)) * 100) / 100), 'Amount Paid': gbp(paid), 'Customs': gbp(d.customs), 'DOMS': gbp(d.doms), 'EMS': gbp(d.ems),
    'GO': d.go === '' ? '' : `${d.go} (https://app.notion.com/p/go-${++slug}?pvs=21)`, 'Initial Due Date': d.initialDue, 'Initials': gbp(d.initials), 'Item': d.item,
    'Joiners': d.joiner ? `${d.relation ?? d.joiner}   (https://app.notion.com/p/j-${++slug}?pvs=21)` : '', 'Order Status': d.status, 'Packing fee': d.packing === null ? '' : String(d.packing),
    'Quantity': d.qty === null ? '' : `${d.qty}${Number.isInteger(d.qty) ? '.0' : ''}`, 'Ready To Pack Date': d.ready, 'Storage Deadline': d.storage, 'Total Due': gbp(total), 'Tracking number': d.tracking,
  };
  return HEADER.map((h) => q(cells[h] ?? '')).join(',');
}
export const csv = (rows, { bom = false } = {}) => `${bom ? '\uFEFF' : ''}${HEADER.map(q).join(',')}\n${rows.join('\n')}\n`;
