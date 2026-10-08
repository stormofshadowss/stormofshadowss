import express from 'express';
import { wrap } from '../lib/http.js';
import { requireAdmin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { processImage, saveFiles, removeFiles, urls, MAX_UPLOAD_BYTES, FILE_NAME } from '../lib/images.js';

// One picture each, in four places. (The table and column names come from this fixed list only — never from the request.)
const KINDS = {
  item: { table: 'items', col: 'image_id', what: 'item' },
  shop: { table: 'leftover_items', col: 'image_id', what: 'shop item' },
  order: { table: 'group_orders', col: 'cover_image_id', what: 'group order' },
  group: { table: 'artist_groups', col: 'cover_image_id', what: 'artist group' },
};

export function imageRoutes(app, { pool, cfg }) {
  const admin = [requireAdmin];

  // Serving: only files we made (random names ending .webp), cached for a year — a new picture always gets a new name.
  app.use('/uploads', (req, res, next) => (FILE_NAME.test(req.path.slice(1)) ? next() : res.status(404).end()),
    express.static(cfg.uploadsDir, { index: false, dotfiles: 'deny', immutable: true, maxAge: '365d' }));

  // The picture arrives as the raw bytes of the file (no form encoding). Too big is explained, not a vague error.
  const rawBody = (req, res, next) => express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES })(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') return next(new HttpError(413, `That picture is too big — the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Try a smaller or lower-quality copy.`, 'too_big'));
    next(err);
  });
  const target = async (req) => {
    const k = KINDS[req.params.kind]; if (!k) throw notFound('No such place for a picture');
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw notFound(`No such ${k.what}`);
    const [[row]] = await pool.query(`SELECT id FROM ${k.table} WHERE id = ?`, [id]);
    if (!row) throw notFound(`No such ${k.what}`);
    return { k, id };
  };

  // Set (or replace) the picture. The old one is deleted, so nothing piles up.
  app.put('/api/admin/images/:kind/:id', admin, rawBody, wrap(async (req, res) => {
    const { k, id } = await target(req);
    const proc = await processImage(req.body);
    let filename;
    try { filename = await saveFiles(cfg.uploadsDir, proc); }
    catch { throw new HttpError(500, "Pictures can't be saved right now — the server's uploads folder isn't writable. Check UPLOADS_DIR.", 'uploads_unwritable'); }
    let oldFile = null, imageId;
    try {
      imageId = await withTx(pool, async (conn) => {
        const [[t]] = await conn.query(`SELECT id, ${k.col} AS img FROM ${k.table} WHERE id = ? FOR UPDATE`, [id]);
        if (!t) throw notFound(`No such ${k.what}`);
        const [ins] = await conn.query('INSERT INTO images (filename, mime, width, height, bytes) VALUES (?,?,?,?,?)', [filename, 'image/webp', proc.width, proc.height, proc.full.length]);
        await conn.query(`UPDATE ${k.table} SET ${k.col} = ? WHERE id = ?`, [ins.insertId, id]);
        if (t.img) { const [[o]] = await conn.query('SELECT filename FROM images WHERE id = ?', [t.img]); oldFile = o?.filename || null; await conn.query('DELETE FROM images WHERE id = ?', [t.img]); }
        await audit(conn, req.account.id, 'image.set', req.params.kind, id);
        return ins.insertId;
      });
    } catch (e) { await removeFiles(cfg.uploadsDir, filename); throw e; }          // nothing saved, so don't leave the files behind
    await removeFiles(cfg.uploadsDir, oldFile);
    res.json({ ok: true, image: { id: imageId, ...urls(filename), width: proc.width, height: proc.height } });
  }));

  app.delete('/api/admin/images/:kind/:id', admin, wrap(async (req, res) => {
    const { k, id } = await target(req);
    let oldFile = null;
    await withTx(pool, async (conn) => {
      const [[t]] = await conn.query(`SELECT ${k.col} AS img FROM ${k.table} WHERE id = ? FOR UPDATE`, [id]);
      if (!t?.img) return;
      const [[o]] = await conn.query('SELECT filename FROM images WHERE id = ?', [t.img]); oldFile = o?.filename || null;
      await conn.query(`UPDATE ${k.table} SET ${k.col} = NULL WHERE id = ?`, [id]);
      await conn.query('DELETE FROM images WHERE id = ?', [t.img]);
      await audit(conn, req.account.id, 'image.remove', req.params.kind, id);
    });
    await removeFiles(cfg.uploadsDir, oldFile);
    res.json({ ok: true, removed: !!oldFile });
  }));
}
