// Instagram handles: letters, numbers, periods, underscores, up to 30 characters.
export function normalizeHandle(v) {
  return String(v ?? '').trim().toLowerCase().replace(/^@/, '');
}
export const HANDLE_RE = /^[a-z0-9._]{1,30}$/;
export const isValidHandle = (h) => HANDLE_RE.test(h);
