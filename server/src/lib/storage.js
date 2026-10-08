// How long the GOM will keep an item on hand once it's ready to pack, by size bucket:
// photocards and other small things get longer, bulky things less. A deadline set by hand always wins.
export const STORAGE_DAYS = { XS: 60, S: 60, M: 30, L: 30, XL: 30 };
export const storageCase = (col = 'c.size_bucket') => `CASE ${Object.entries(STORAGE_DAYS).map(([k, d]) => `WHEN ${col} = '${k}' THEN ${d}`).join(' ')} ELSE 30 END`;
