import { z } from 'zod';
import { addDaysYMD, daysBetweenYMD } from './due.js';
// How long the GOM will keep an item on hand once it's ready to pack, by size bucket:
// photocards and other small things get longer, bulky things less. A deadline set by hand always wins.
export const STORAGE_DAYS = { XS: 60, S: 60, M: 30, L: 30, XL: 30 };
export const storageCase = (col = 'c.size_bucket') => `CASE ${Object.entries(STORAGE_DAYS).map(([k, d]) => `WHEN ${col} = '${k}' THEN ${d}`).join(' ')} ELSE 30 END`;

// The storage deadline for ONE item, as the joiner sees it: a deadline you set by hand wins, else the date it became ready to pack plus its size's days. (Same rule as the Overdue tab's SQL above.)
// Only an item that is ready to pack and not yet sent has one. 'late' = the date has passed (it lives all day, like every due date); 'soon' = within STORAGE_SOON_DAYS.
export const STORAGE_SOON_DAYS = 7;
export const storageDeadlineOf = ({ size, readyDate, override }) => (override ? String(override).slice(0, 10) : readyDate ? addDaysYMD(String(readyDate).slice(0, 10), STORAGE_DAYS[size] ?? 30) : null);
export const storageStatusOf = (deadline, today) => { if (!deadline) return null; const left = daysBetweenYMD(String(today).slice(0, 10), deadline); return left < 0 ? 'late' : left <= STORAGE_SOON_DAYS ? 'soon' : 'ok'; };

// A day typed as YYYY-MM-DD that is a REAL day (the shape alone lets 2026-02-31 through, which the database then refuses).
export const realDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-31').refine((v) => { const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; }, "That isn't a real date");
