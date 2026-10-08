import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 64, MAXMEM = 64 * 1024 * 1024;

// Stored as  scrypt$N$r$p$salt$hash  — the settings travel with the hash, so they can be raised later.
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [alg, n, r, p, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +n, r: +r, p: +p, maxmem: MAXMEM });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch { return false; }
}

// Used when the username doesn't exist, so "no such user" takes as long as "wrong password".
let dummy;
export const dummyHash = () => (dummy ??= hashPassword('not-a-real-password-just-for-timing'));

const COMMON = ['password', 'passw0rd', '123456789', 'qwertyuiop', 'letmein', 'iloveyou', 'admin', 'welcome', 'stormofshadowss', 'straykids'];
// Returns a plain-English problem, or null if the password is acceptable.
export function passwordProblem(password, username = '') {
  if (typeof password !== 'string' || password.length < 12) return 'The password must be at least 12 characters. A few random words strung together works well.';
  if (password.length > 200) return 'The password is too long (200 characters at most).';
  const lower = password.toLowerCase();
  if (username && lower.includes(String(username).toLowerCase())) return 'The password must not contain the username.';
  if (new Set(password).size < 5) return 'The password is too repetitive.';
  if (COMMON.some((c) => lower.includes(c))) return 'The password is too easy to guess — avoid common words.';
  return null;
}
