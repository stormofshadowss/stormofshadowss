import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// COLOURS ARE TOKENS (--ink, --surface, --line …) that change between light and dark. A rule that names a token that doesn't exist silently falls back to a fixed colour — fine in one theme, unreadable in the other
// (the photocard pop-up once used a made-up `--card` and showed dark text on a dark box in light mode). This catches that: every token used by the stylesheet or the page scripts must be defined.
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
const light = css.match(/:root \{(.*?)\}/s)[1], dark = css.match(/:root\[data-theme="dark"\] \{(.*?)\}/s)[1];
const names = (text) => new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const LOCAL = new Set(['--p', '--h', '--gone-dim']);             // set on an element by the page script itself (the fill circle's share, an avatar's hue, how much taken cards are dimmed)
const files = (dir) => fs.readdirSync(path.join(pub, dir)).filter((f) => f.endsWith('.js')).map((f) => path.join(pub, dir, f));
const usedIn = (text) => new Set([...text.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));

test('EVERY COLOUR TOKEN USED IS DEFINED (so nothing falls back to a fixed colour in one theme)', () => {
  const defined = names(light);
  const missing = (set) => [...set].filter((n) => !defined.has(n) && !LOCAL.has(n)).sort();
  assert.deepEqual(missing(usedIn(css)), [], 'style.css uses a token that is never defined');
  for (const f of [...files('site'), ...files('gom')]) assert.deepEqual(missing(usedIn(fs.readFileSync(f, 'utf8'))), [], `${path.basename(f)} uses a token that is never defined`);
});

test('THE DARK THEME REDEFINES THE TOKENS THAT CARRY TEXT AND SURFACES, and the photocard pop-up takes its colours from them', () => {
  const d = names(dark); for (const n of ['--ink', '--soft', '--paper', '--surface', '--surface-2', '--line', '--accent']) assert.ok(d.has(n), `${n} has a dark value`);
  const pop = css.match(/\.pcpop-box \{(.*?)\}/s)[1]; assert.match(pop, /background:var\(--surface\)/); assert.match(pop, /color:var\(--ink\)/); assert.doesNotMatch(pop, /#[0-9a-f]{3,6}/i, 'no fixed colour that would ignore the theme');
});
