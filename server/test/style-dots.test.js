import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The joiner's set map marks a taken spot in a SECURED set in RED — green could be misread as "open". The GOM's Sets tab keeps its green for "confirmed" (a different thing).
const css = readFileSync(new URL('../../public/style.css', import.meta.url), 'utf8'), shopJs = readFileSync(new URL('../../public/site/shop.js', import.meta.url), 'utf8');
const hexes = (name) => [...css.matchAll(new RegExp(`--${name}:(#[0-9a-fA-F]{6})`, 'g'))].map((m) => m[1]);
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hue = (h) => { const [r, g, b] = rgb(h).map((v) => v / 255), max = Math.max(r, g, b), d = max - Math.min(r, g, b); if (!d) return 0; const x = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return ((x * 60) + 360) % 360; };
const lum = (h) => { const [r, g, b] = rgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('THE "SOLD" RED IS DEFINED FOR BOTH LOOKS, IS A TRUE RED (not green, orange or pink), and stands out against the card in each', () => {
  const sold = hexes('sold'), surface = hexes('surface'); assert.equal(sold.length, 2, 'one red for the light look, one for the dark'); assert.ok(surface.length >= 2);
  for (const [i, look] of ['light', 'dark'].entries()) { const h = hue(sold[i]); assert.ok(h >= 340 || h <= 12, `${look}: ${sold[i]} has hue ${Math.round(h)}° — must be red`); assert.ok(contrast(sold[i], surface[i]) >= 3, `${look}: ${sold[i]} against the card is ${contrast(sold[i], surface[i]).toFixed(1)}:1 (needs 3:1)`); }
});

test('THE TAKEN-IN-A-SECURED-SET DOT USES THE RED, the open ring is not red, and the GOM\'s green (.dot.ok) is untouched', () => {
  assert.match(css, /\.dot\.lock \{ background:var\(--sold\); border-color:var\(--sold\);/); assert.match(css, /\.dot\.ok \{ background:var\(--ok-ink\); border-color:var\(--ok-ink\);/, 'the Sets tab keeps its green for confirmed');
  assert.match(css, /\.dot\.free \{ background:transparent; border-color:var\(--accent\);/, 'an open spot is a ring, not a fill');
  assert.ok(!/class="dot \$\{[^}]*'ok'/.test(shopJs) && !shopJs.includes('dot ok'), 'the joiner page never uses the green dot');
});
