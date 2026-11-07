import sharp from 'sharp';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../errors.js';
import { FILE_NAME } from './images.js';

// BOARD PHOTOS. A board is a spread of many cards, so it needs far more detail than an item picture: the full-size copy (up to 6000 px) is kept so each card can be cropped out sharply, a 2400 px copy is shown on the
// board, and a small thumbnail is used in lists. Like every upload it is decoded for real, turned upright, and re-saved as WebP — which strips anything hidden in the original (location, camera details).
export const MAX_BOARD_BYTES = 25 * 1024 * 1024;
const SOURCE_PX = 6000, DISPLAY_PX = 2400, THUMB_PX = 480, CROP_PX = 900, CROP_THUMB_PX = 300, MAX_PIXELS = 80_000_000;
const FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);
const NOT_A_PICTURE = new HttpError(400, "That doesn't look like a picture we can use. Please upload a JPEG, PNG, WebP or GIF.", 'not_an_image');

export async function processBoardImage(buf) {
  if (!buf || !buf.length) throw new HttpError(400, 'No picture was sent.', 'no_image');
  const open = () => sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
  try {
    const meta = await open().metadata(); if (!FORMATS.has(meta.format)) throw NOT_A_PICTURE;
    const fit = (px) => ({ width: px, height: px, fit: 'inside', withoutEnlargement: true });
    const source = await open().rotate().resize(fit(SOURCE_PX)).webp({ quality: 88 }).toBuffer({ resolveWithObject: true });
    const display = await sharp(source.data).resize(fit(DISPLAY_PX)).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
    const thumb = await sharp(source.data).resize(fit(THUMB_PX)).webp({ quality: 78 }).toBuffer();
    return { source: source.data, srcWidth: source.info.width, srcHeight: source.info.height, full: display.data, thumb, width: display.info.width, height: display.info.height };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (/pixel limit/i.test(e.message)) throw new HttpError(400, 'That picture is far too large (over 80 megapixels). Please shrink it first.', 'too_many_pixels');
    throw NOT_A_PICTURE;
  }
}

export async function saveOne(dir, buf) {
  await fs.mkdir(dir, { recursive: true });
  const name = `${crypto.randomBytes(16).toString('hex')}.webp`;
  await fs.writeFile(path.join(dir, name), buf, { flag: 'wx' });
  return name;
}
export async function removeOne(dir, filename) { if (filename && FILE_NAME.test(filename)) await fs.rm(path.join(dir, filename), { force: true }).catch(() => {}); }
export const readSource = (dir, filename) => fs.readFile(path.join(dir, filename));

// One card cut out of the full-size photo. x, y, w, h are fractions (0–1) of the photo; the crop is shrunk to a sensible size, plus a small thumbnail.
export async function makeCrop(sourceBuf, srcWidth, srcHeight, { x, y, w, h }) {
  const left = Math.max(0, Math.min(srcWidth - 1, Math.round(x * srcWidth))), top = Math.max(0, Math.min(srcHeight - 1, Math.round(y * srcHeight)));
  const width = Math.max(1, Math.min(srcWidth - left, Math.round(w * srcWidth))), height = Math.max(1, Math.min(srcHeight - top, Math.round(h * srcHeight)));
  const base = () => sharp(sourceBuf).extract({ left, top, width, height });
  const fit = (px) => ({ width: px, height: px, fit: 'inside', withoutEnlargement: true });
  const full = await base().resize(fit(CROP_PX)).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
  return { full: full.data, thumb: await base().resize(fit(CROP_THUMB_PX)).webp({ quality: 78 }).toBuffer(), width: full.info.width, height: full.info.height };
}
