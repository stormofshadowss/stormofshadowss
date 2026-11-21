import { z } from 'zod';

// The tracking number of a parcel posted to a joiner: ONE per parcel. Letters, numbers, spaces and dashes (4–40); blank clears it.
export const trackingField = z.string().trim().max(40, 'A tracking number is at most 40 characters')
  .refine((v) => v === '' || /^[A-Za-z0-9][A-Za-z0-9 -]{3,39}$/.test(v), 'A tracking number is letters, numbers, spaces and dashes (4–40 characters)')
  .transform((v) => (v === '' ? null : v.replace(/\s+/g, ' ')));

// A "Track it" link only where the carrier is certain (Royal Mail); every other method shows the number alone.
export const trackingUrl = (method, no) => (no && /royal mail/i.test(method || '') ? `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(String(no).replace(/\s+/g, ''))}` : null);
