import sharp from 'sharp';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../errors.js';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;     // the file as sent (phone photos are usually 2–6 MB)
const FULL_PX = 1200, THUMB_PX = 480;                 // longest side of the picture and of its thumbnail
const MAX_INPUT_PIXELS = 40_000_000;                  // refuse "decompression bomb" files (tiny to send, enormous to open)
const FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);
export const FILE_NAME = /^[a-f0-9]{32}(-t)?\.webp$/;

const NOT_A_PICTURE = new HttpError(400, "That doesn't look like a picture we can use. Please upload a JPEG, PNG, WebP or GIF.", 'not_an_image');

// Every upload is decoded for real (the file name and the type the browser claims are never trusted), turned upright using its camera
// orientation, shrunk, and re-saved as WebP — which also strips everything hidden in the original (GPS location, camera details, anything
// embedded), so a photo taken at home can't give away where you live. A smaller thumbnail is made for lists and cards.
export async function processImage(buf) {
  if (!buf || !buf.length) throw new HttpError(400, 'No picture was sent.', 'no_image');
  const open = () => sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
  try {
    const meta = await open().metadata();
    if (!FORMATS.has(meta.format)) throw NOT_A_PICTURE;
    const full = await open().rotate().resize({ width: FULL_PX, height: FULL_PX, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
    const thumb = await open().rotate().resize({ width: THUMB_PX, height: THUMB_PX, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    return { full: full.data, thumb, width: full.info.width, height: full.info.height };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (/pixel limit/i.test(e.message)) throw new HttpError(400, 'That picture is far too large (over 40 megapixels). Please shrink it first.', 'too_many_pixels');
    throw NOT_A_PICTURE;
  }
}

// Files get random names, so a picture's address can't be guessed and a new upload never overwrites an old one.
export async function saveFiles(dir, { full, thumb }) {
  await fs.mkdir(dir, { recursive: true });
  const base = crypto.randomBytes(16).toString('hex');
  await fs.writeFile(path.join(dir, `${base}.webp`), full, { flag: 'wx' });
  try { await fs.writeFile(path.join(dir, `${base}-t.webp`), thumb, { flag: 'wx' }); }
  catch (e) { await fs.rm(path.join(dir, `${base}.webp`), { force: true }); throw e; }
  return `${base}.webp`;
}
export async function removeFiles(dir, filename) {
  if (!filename || !FILE_NAME.test(filename)) return;
  await Promise.all([filename, filename.replace('.webp', '-t.webp')].map((f) => fs.rm(path.join(dir, f), { force: true }).catch(() => {})));
}
export const urls = (filename) => ({ url: `/uploads/${filename}`, thumb: `/uploads/${filename.replace('.webp', '-t.webp')}` });
export const imageOut = (filename, width, height) => (filename ? { ...urls(filename), width, height } : null);
