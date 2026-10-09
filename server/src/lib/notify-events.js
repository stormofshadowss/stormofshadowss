// The kinds of email a person can switch on or off (all of them are on by default once emails are enabled). Sign-in links and security notices are not in this list: they are always sent.
export const NOTIFY_EVENTS = [
  { key: 'claimsSecured', label: 'My claims are confirmed' },
  { key: 'paymentDecided', label: 'A payment of mine is approved or declined' },
  { key: 'parcelShipped', label: 'My parcel is posted' },
  { key: 'companionInvited', label: 'A friend asks to ship a parcel together' },
  { key: 'cancelDecided', label: 'The GOM answers my request to cancel' },
  { key: 'overdue', label: 'Reminders about payments that are overdue' },
];
export const EVENT_KEYS = NOTIFY_EVENTS.map((e) => e.key);
export const offSet = (s) => new Set(String(s || '').split(',').map((x) => x.trim()).filter(Boolean));
export const offString = (set) => EVENT_KEYS.filter((k) => set.has(k)).join(',');
