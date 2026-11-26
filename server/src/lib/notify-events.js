// The kinds of email a person can switch on or off (all of them are on by default once emails are enabled — except the OPT-IN ones, marked optIn, which are off until the person switches them on). Sign-in links and security notices are not in this list: they are always sent.
export const NOTIFY_EVENTS = [
  { key: 'claimsSecured', label: 'My claims are confirmed' },
  { key: 'paymentDecided', label: 'A payment of mine is approved or declined' },
  { key: 'parcelShipped', label: 'My parcel is posted' },
  { key: 'companionInvited', label: 'A friend asks to ship a parcel together' },
  { key: 'cancelDecided', label: 'The GOM answers my request to cancel' },
  { key: 'priceChanged', label: 'The price of one of my claims changes' },
  { key: 'overdue', label: 'Reminders about payments that are overdue' },
  { key: 'itemsReady', label: 'More of my items are ready, and I can add them to my shipping request' },
  { key: 'pauseReminder', label: 'A reminder when my paused shipping request has been paused for a month' },
  { key: 'orderCancelled', label: 'A group order or item I claimed is cancelled', optIn: true },
];
export const EVENT_KEYS = NOTIFY_EVENTS.map((e) => e.key);
export const OPT_IN_KEYS = NOTIFY_EVENTS.filter((e) => e.optIn).map((e) => e.key);
export const offSet = (s) => new Set(String(s || '').split(',').map((x) => x.trim()).filter(Boolean));
export const offString = (set) => EVENT_KEYS.filter((k) => !OPT_IN_KEYS.includes(k) && set.has(k)).join(',');                  // the kinds switched OFF (opt-in kinds are never in this list)
export const optInString = (set) => OPT_IN_KEYS.filter((k) => set.has(k)).join(',');                                             // the opt-in kinds switched ON
