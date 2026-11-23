import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// UPDATES SHOW UP BY THEMSELVES. Every page is sent with each of its script and stylesheet links stamped with a short fingerprint of that file —
// /gom/orders.js becomes /gom/orders.js?v=3fa9c1d2e0 — so when a file changes its link changes, and Cloudflare and browsers fetch the new one. Nobody has to purge a cache.
const cache = new Map();                                                                    // file → { mtimeMs, size, hash }: a file is only re-read when it has changed

// The fingerprint of a file under the public folder (null if it isn't a real file inside it).
export function assetHash(publicDir, urlPath) {
  const root = path.resolve(publicDir), file = path.resolve(root, `.${path.posix.normalize(`/${urlPath}`)}`);
  if (!file.startsWith(root + path.sep)) return null;
  let st; try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  const hit = cache.get(file); if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.hash;
  const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, hash }); return hash;
}

// Stamp every local <script src="/…js"> and <link rel="stylesheet" href="/…css"> in a page. Anything else is left exactly as it is: other links, addresses on other sites,
// links already carrying a ? or #, files that don't exist, inline scripts.
export function versionHtml(html, publicDir) {
  return html.replace(/<(script|link)\b[^>]*>/gi, (tag, name) => {
    const isScript = name.toLowerCase() === 'script';
    if (!isScript && !/\brel\s*=\s*["']?stylesheet\b/i.test(tag)) return tag;
    return tag.replace(new RegExp(`(\\s${isScript ? 'src' : 'href'}\\s*=\\s*)(["'])([^"']*)\\2`, 'i'), (all, pre, q, url) => {
      if (!url.startsWith('/') || url.startsWith('//') || /[?#]/.test(url) || !/\.(js|css)$/i.test(url)) return all;
      const v = assetHash(publicDir, url); return v ? `${pre}${q}${url}?v=${v}${q}` : all;
    });
  });
}

// The page file for an address: "/" is index.html, "/x.html" is x.html — only inside the public folder, only if it exists.
export function pageFile(publicDir, urlPath) {
  let p; try { p = decodeURIComponent(urlPath); } catch { return null; }
  if (p.includes('\0')) return null;
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, ''); if (!/\.html$/i.test(rel)) return null;
  const root = path.resolve(publicDir), file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) return null;
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}
