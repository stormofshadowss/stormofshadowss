import express from 'express';
import { z } from 'zod';
import { wrap } from '../lib/http.js';
import { requireAdmin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { HttpError, bad, conflict, notFound } from '../errors.js';
import { imageOut, removeFiles, saveFiles, urls } from '../lib/images.js';
import { MAX_BOARD_BYTES, processBoardImage, saveOne, removeOne, readSource, makeCrop } from '../lib/card-images.js';
import { readingOrder } from '../lib/card-layout.js';
import { syncBundle, removeCardItems } from '../lib/card-sync.js';
import { todayUK } from '../lib/closing.js';

const money = z.number().min(0.01, 'A price must be at least 1p').max(100000).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'At most 2 decimal places');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-31').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'That date does not exist');
const r6 = (n) => Math.round(n * 1e6) / 1e6;

const typeIn = z.object({ name: z.string().trim().min(1, 'Give the type a name').max(60), price: money });
const bundleFields = {
  title: z.string().trim().min(1, 'Give the bundle a name').max(160), groupId: z.number().int().positive().nullable(), description: z.string().trim().max(2000).nullable(),
  onHand: z.boolean(), closesOn: day.nullable(), payDays: z.number().int().min(1).max(60), status: z.enum(['draft', 'open', 'closed']),
};
const boxIn = z.object({
  id: z.number().int().positive().optional(), x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.004).max(1), h: z.number().min(0.004).max(1),
  typeId: z.number().int().positive().nullable().optional(), price: money.optional(), priceOverride: z.boolean().optional(), qty: z.number().int().min(1).max(999), note: z.string().trim().max(255).nullable().optional(),
}).refine((b) => b.x + b.w <= 1.0001 && b.y + b.h <= 1.0001, 'A box has to stay inside the photo');

export function cardRoutes(app, { pool, cfg }) {
  const admin = [requireAdmin];
  const rawBoard = (req, res, next) => express.raw({ type: () => true, limit: MAX_BOARD_BYTES })(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') return next(new HttpError(413, `That photo is too big — the limit for a board is ${MAX_BOARD_BYTES / 1024 / 1024} MB. Try a lower-quality copy.`, 'too_big'));
    next(err);
  });
  const dupType = (e) => { if (e?.code === 'ER_DUP_ENTRY') throw conflict('There is already a card type with that name', 'dup_type'); throw e; };

  const boxOut = (r) => ({ id: r.id, itemId: r.item_id || null, number: r.number, x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h), typeId: r.type_id, price: Number(r.price), priceOverride: !!r.price_override, qty: r.qty, note: r.note || '', crop: r.crop_file ? urls(r.crop_file) : null });
  const boardOut = (b, extra = {}) => ({ id: b.id, bundleId: b.bundle_id, title: b.title, sortOrder: b.sort_order, image: imageOut(b.filename, b.iw, b.ih), aspect: b.width / b.height, ...extra });
  const BOARD_SELECT = `SELECT cb.id, cb.bundle_id, cb.title, cb.sort_order, cb.width, cb.height, i.filename, i.width AS iw, i.height AS ih,
      (SELECT COUNT(*) FROM card_boxes x WHERE x.board_id = cb.id) AS boxCount, (SELECT COALESCE(SUM(x.qty), 0) FROM card_boxes x WHERE x.board_id = cb.id) AS copies
    FROM card_boards cb LEFT JOIN images i ON i.id = cb.image_id`;

  // Everything for the Cards tab: the card types, the groups to choose from, and every bundle with its boards.
  app.get('/api/admin/cards', admin, wrap(async (req, res) => {
    const [types] = await pool.query('SELECT id, name, default_price AS price, sort_order AS sortOrder FROM card_types ORDER BY sort_order, id');
    const [groups] = await pool.query('SELECT id, name FROM artist_groups WHERE is_hidden = 0 ORDER BY sort_order, name');
    const [bundles] = await pool.query("SELECT b.id, b.group_id AS groupId, g.name AS groupName, b.title, b.description, b.on_hand AS onHand, DATE_FORMAT(b.closes_on, '%Y-%m-%d') AS closesOn, b.pay_days AS payDays, b.status, b.order_id AS orderId, (SELECT COUNT(*) FROM claims c WHERE c.order_id = b.order_id AND c.status <> 'cancelled') AS claims FROM card_bundles b LEFT JOIN artist_groups g ON g.id = b.group_id ORDER BY b.id DESC");
    const [boards] = await pool.query(`${BOARD_SELECT} ORDER BY cb.sort_order, cb.id`);
    res.json({
      types: types.map((t) => ({ ...t, price: Number(t.price) })), groups,
      bundles: bundles.map((b) => { const mine = boards.filter((x) => x.bundle_id === b.id).map((x) => boardOut(x, { cards: Number(x.boxCount), copies: Number(x.copies) })); return { ...b, onHand: !!b.onHand, claims: Number(b.claims), boards: mine, cards: mine.reduce((s, x) => s + x.cards, 0), copies: mine.reduce((s, x) => s + x.copies, 0) }; }),
    });
  }));

  // ── card types: a name and a default price; a card follows its type's price unless it has its own ──
  app.post('/api/admin/card-types', admin, wrap(async (req, res) => {
    const b = typeIn.parse(req.body);
    const id = await withTx(pool, async (conn) => {
      const [[m]] = await conn.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM card_types');
      const [r] = await conn.query('INSERT INTO card_types (name, default_price, sort_order) VALUES (?,?,?)', [b.name, b.price, m.n]).catch(dupType);
      await audit(conn, req.account.id, 'card_type.create', 'card_type', r.insertId, { name: b.name, price: b.price });
      return r.insertId;
    });
    res.status(201).json({ ok: true, id });
  }));
  app.patch('/api/admin/card-types/:id', admin, wrap(async (req, res) => {
    const id = Number(req.params.id), b = typeIn.partial().refine((x) => x.name !== undefined || x.price !== undefined, 'Nothing to change').parse(req.body);
    const out = await withTx(pool, async (conn) => {
      const [[t]] = await conn.query('SELECT id FROM card_types WHERE id = ? FOR UPDATE', [id]); if (!t) throw notFound('No such card type');
      if (b.name !== undefined) await conn.query('UPDATE card_types SET name = ? WHERE id = ?', [b.name, id]).catch(dupType);
      let repriced = 0;
      if (b.price !== undefined) {                                                                   // cards that follow this type's price move with it; ones with their own price don't
        await conn.query('UPDATE card_types SET default_price = ? WHERE id = ?', [b.price, id]);
        [{ affectedRows: repriced }] = await conn.query('UPDATE card_boxes SET price = ? WHERE type_id = ? AND price_override = 0', [b.price, id]);
      }
      await audit(conn, req.account.id, 'card_type.update', 'card_type', id, { ...b, repriced });
      return { repriced };
    });
    res.json({ ok: true, ...out });
  }));
  app.delete('/api/admin/card-types/:id', admin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    await withTx(pool, async (conn) => {
      const [[t]] = await conn.query('SELECT id FROM card_types WHERE id = ? FOR UPDATE', [id]); if (!t) throw notFound('No such card type');
      await conn.query('UPDATE card_boxes SET price_override = 1 WHERE type_id = ?', [id]);          // their price stays exactly as it is
      await conn.query('DELETE FROM card_types WHERE id = ?', [id]);
      await audit(conn, req.account.id, 'card_type.delete', 'card_type', id);
    });
    res.json({ ok: true });
  }));

  // ── bundles ──
  const checkGroup = async (groupId) => { if (groupId && !(await pool.query('SELECT 1 FROM artist_groups WHERE id = ?', [groupId]))[0].length) throw bad('That group does not exist', 'no_such_group'); };
  app.post('/api/admin/card-bundles', admin, wrap(async (req, res) => {
    const b = z.object({ title: bundleFields.title, groupId: bundleFields.groupId.optional(), description: bundleFields.description.optional(), onHand: bundleFields.onHand.optional(), closesOn: bundleFields.closesOn.optional(), payDays: bundleFields.payDays.optional() }).parse(req.body);
    await checkGroup(b.groupId);
    const id = await withTx(pool, async (conn) => {
      const [r] = await conn.query('INSERT INTO card_bundles (group_id, title, description, on_hand, closes_on, pay_days) VALUES (?,?,?,?,?,?)', [b.groupId || null, b.title, b.description || null, b.onHand === false ? 0 : 1, b.closesOn || null, b.payDays ?? 5]);
      await audit(conn, req.account.id, 'card_bundle.create', 'card_bundle', r.insertId, { title: b.title });
      return r.insertId;
    });
    res.status(201).json({ ok: true, id });
  }));
  app.patch('/api/admin/card-bundles/:id', admin, wrap(async (req, res) => {
    const id = Number(req.params.id), b = z.object(bundleFields).partial().refine((x) => Object.keys(x).length > 0, 'Nothing to change').parse(req.body);
    if (b.groupId !== undefined) await checkGroup(b.groupId);
    await withTx(pool, async (conn) => {
      const [[cur]] = await conn.query('SELECT id, status, on_hand, order_id FROM card_bundles WHERE id = ? FOR UPDATE', [id]); if (!cur) throw notFound('No such bundle');
      if (b.status === 'draft' && cur.order_id) throw conflict('A published bundle can be closed, but not turned back into a draft.', 'already_published');
      if (b.onHand !== undefined && cur.order_id && !!cur.on_hand !== b.onHand) {
        const [[n]] = await conn.query('SELECT COUNT(*) AS n FROM claims WHERE order_id = ?', [cur.order_id]);
        if (n.n) throw conflict("This bundle already has claims, so it can't be switched between on hand and not on hand.", 'has_claims');
      }
      if (b.status === 'open' && cur.status !== 'open') {                                            // publishing needs something to sell
        const [[n]] = await conn.query('SELECT COUNT(*) AS n FROM card_boxes x JOIN card_boards cb ON cb.id = x.board_id WHERE cb.bundle_id = ?', [id]);
        if (!n.n) throw conflict('Add a board with at least one card before publishing.', 'nothing_to_sell');
      }
      const sets = [], vals = [], map = { title: 'title', groupId: 'group_id', description: 'description', onHand: 'on_hand', closesOn: 'closes_on', payDays: 'pay_days', status: 'status' };
      for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col} = ?`); vals.push(k === 'onHand' ? (b[k] ? 1 : 0) : k === 'description' ? (b[k] || null) : b[k]); }
      await conn.query(`UPDATE card_bundles SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
      if (cur.status !== 'draft' || b.status === 'open') await syncBundle(conn, cfg.uploadsDir, id);                 // the real order and items behind it follow (publishing creates them)
      await audit(conn, req.account.id, 'card_bundle.update', 'card_bundle', id, b);
    });
    res.json({ ok: true });
  }));
  app.delete('/api/admin/card-bundles/:id', admin, wrap(async (req, res) => {
    const id = Number(req.params.id); let boards = [], crops = [], itemFiles = [];
    await withTx(pool, async (conn) => {
      const [[cur]] = await conn.query('SELECT id, order_id FROM card_bundles WHERE id = ? FOR UPDATE', [id]); if (!cur) throw notFound('No such bundle');
      const [bs] = await conn.query('SELECT cb.id, cb.source_file, i.filename, cb.image_id FROM card_boards cb LEFT JOIN images i ON i.id = cb.image_id WHERE cb.bundle_id = ?', [id]); boards = bs;
      const [cs] = await conn.query('SELECT x.crop_file, x.crop_image_id, x.item_id FROM card_boxes x JOIN card_boards cb ON cb.id = x.board_id WHERE cb.bundle_id = ?', [id]); crops = cs;
      const itemIds = crops.map((c) => c.item_id).filter(Boolean);
      if (cur.order_id || itemIds.length) itemFiles = await removeCardItems(conn, itemIds, cur.order_id);          // refuses if anyone has a real claim or money behind it — close the bundle instead
      await conn.query('DELETE FROM card_bundles WHERE id = ?', [id]);
      const imgIds = [...boards.map((x) => x.image_id), ...crops.map((c) => c.crop_image_id)].filter(Boolean); if (imgIds.length) await conn.query('DELETE FROM images WHERE id IN (?)', [imgIds]);
      await audit(conn, req.account.id, 'card_bundle.delete', 'card_bundle', id);
    });
    for (const x of boards) { await removeFiles(cfg.uploadsDir, x.filename); await removeOne(cfg.uploadsDir, x.source_file); }
    for (const c of crops) await removeFiles(cfg.uploadsDir, c.crop_file); for (const f of itemFiles) await removeFiles(cfg.uploadsDir, f);
    res.json({ ok: true });
  }));

  // ── boards: one spread photo each ──
  app.put('/api/admin/card-bundles/:id/boards', admin, rawBoard, wrap(async (req, res) => {
    const id = Number(req.params.id); const [[bundle]] = await pool.query('SELECT id FROM card_bundles WHERE id = ?', [id]); if (!bundle) throw notFound('No such bundle');
    const title = String(req.query.title || '').trim().slice(0, 120);
    const proc = await processBoardImage(req.body); let display, source;
    try { display = await saveFiles(cfg.uploadsDir, proc); source = await saveOne(cfg.uploadsDir, proc.source); }
    catch { if (display) await removeFiles(cfg.uploadsDir, display); throw new HttpError(500, "Pictures can't be saved right now — the server's uploads folder isn't writable. Check UPLOADS_DIR.", 'uploads_unwritable'); }
    let boardId;
    try {
      boardId = await withTx(pool, async (conn) => {
        const [[n]] = await conn.query('SELECT COUNT(*) AS n, COALESCE(MAX(sort_order), 0) + 1 AS next FROM card_boards WHERE bundle_id = ? FOR UPDATE', [id]);
        const [img] = await conn.query('INSERT INTO images (filename, mime, width, height, bytes) VALUES (?,?,?,?,?)', [display, 'image/webp', proc.width, proc.height, proc.full.length]);
        const [r] = await conn.query('INSERT INTO card_boards (bundle_id, title, image_id, source_file, width, height, sort_order) VALUES (?,?,?,?,?,?,?)', [id, title || `Board ${n.n + 1}`, img.insertId, source, proc.srcWidth, proc.srcHeight, n.next]);
        await audit(conn, req.account.id, 'card_board.create', 'card_board', r.insertId, { bundleId: id });
        return r.insertId;
      });
    } catch (e) { await removeFiles(cfg.uploadsDir, display); await removeOne(cfg.uploadsDir, source); throw e; }
    const [[row]] = await pool.query(`${BOARD_SELECT} WHERE cb.id = ?`, [boardId]);
    res.status(201).json({ ok: true, board: boardOut(row, { cards: 0, copies: 0 }) });
  }));
  app.patch('/api/admin/card-boards/:id', admin, wrap(async (req, res) => {
    const id = Number(req.params.id), b = z.object({ title: z.string().trim().min(1).max(120), sortOrder: z.number().int().min(0).max(100000) }).partial().refine((x) => Object.keys(x).length > 0, 'Nothing to change').parse(req.body);
    const [r] = await pool.query('UPDATE card_boards SET title = COALESCE(?, title), sort_order = COALESCE(?, sort_order) WHERE id = ?', [b.title ?? null, b.sortOrder ?? null, id]);
    if (!r.affectedRows) throw notFound('No such board');
    res.json({ ok: true });
  }));
  app.delete('/api/admin/card-boards/:id', admin, wrap(async (req, res) => {
    const id = Number(req.params.id); let files, crops = [], itemFiles = [];
    await withTx(pool, async (conn) => {
      const [[cb]] = await conn.query('SELECT cb.id, cb.source_file, cb.image_id, i.filename FROM card_boards cb LEFT JOIN images i ON i.id = cb.image_id WHERE cb.id = ? FOR UPDATE', [id]); if (!cb) throw notFound('No such board');
      const [cs] = await conn.query('SELECT crop_file, crop_image_id, item_id FROM card_boxes WHERE board_id = ?', [id]); crops = cs; files = cb;
      const itemIds = crops.map((c) => c.item_id).filter(Boolean); if (itemIds.length) itemFiles = await removeCardItems(conn, itemIds);              // refuses if a card on it has a real claim
      await conn.query('DELETE FROM card_boards WHERE id = ?', [id]);
      const imgIds = [cb.image_id, ...crops.map((c) => c.crop_image_id)].filter(Boolean); if (imgIds.length) await conn.query('DELETE FROM images WHERE id IN (?)', [imgIds]);
      await audit(conn, req.account.id, 'card_board.delete', 'card_board', id);
    });
    await removeFiles(cfg.uploadsDir, files.filename); await removeOne(cfg.uploadsDir, files.source_file); for (const c of crops) await removeFiles(cfg.uploadsDir, c.crop_file); for (const f of itemFiles) await removeFiles(cfg.uploadsDir, f);
    res.json({ ok: true });
  }));
  app.get('/api/admin/card-boards/:id', admin, wrap(async (req, res) => {
    const id = Number(req.params.id); const [[row]] = await pool.query(`${BOARD_SELECT} WHERE cb.id = ?`, [id]); if (!row) throw notFound('No such board');
    const [boxes] = await pool.query('SELECT * FROM card_boxes WHERE board_id = ? ORDER BY number', [id]);
    res.json({ board: boardOut(row, { cards: Number(row.boxCount), copies: Number(row.copies) }), boxes: boxes.map(boxOut) });
  }));

  // Save a board's whole layout in one go. Each box keeps its id (and its crop, if it hasn't moved); new or moved boxes get a fresh crop cut from the full-size photo; boxes left out are removed.
  // The numbers are worked out here, in reading order. A box with a type follows the type's price unless priceOverride says the price was set by hand.
  app.put('/api/admin/card-boards/:id/boxes', admin, wrap(async (req, res) => {
    const id = Number(req.params.id), b = z.object({ boxes: z.array(boxIn).max(400, 'A board can have up to 400 cards') }).parse(req.body);
    const [[board]] = await pool.query('SELECT id, bundle_id, source_file, width, height FROM card_boards WHERE id = ?', [id]); if (!board) throw notFound('No such board');
    const [[bundle]] = await pool.query('SELECT id, status FROM card_bundles WHERE id = ?', [board.bundle_id]);
    const [have] = await pool.query('SELECT * FROM card_boxes WHERE board_id = ?', [id]); const haveById = new Map(have.map((r) => [r.id, r]));
    const [types] = await pool.query('SELECT id, default_price AS price FROM card_types'); const typeById = new Map(types.map((t) => [t.id, Number(t.price)]));
    const seen = new Set();
    const rows = b.boxes.map((x, i) => {
      if (x.id) { if (!haveById.has(x.id)) throw bad(`Card ${i + 1} isn't on this board`, 'no_such_box'); if (seen.has(x.id)) throw bad('The same card was sent twice', 'dup_box'); seen.add(x.id); }
      const typed = x.typeId != null; if (typed && !typeById.has(x.typeId)) throw bad(`Card ${i + 1} has a type that doesn't exist`, 'no_such_type');
      const own = !typed || !!x.priceOverride;
      if (own && x.price === undefined) throw bad(`Card ${i + 1} needs a price (it has no type to take one from)`, 'price_required');
      return { id: x.id || null, x: r6(x.x), y: r6(x.y), w: r6(x.w), h: r6(x.h), typeId: typed ? x.typeId : null, price: own ? x.price : typeById.get(x.typeId), override: own ? 1 : 0, qty: x.qty, note: x.note || null };
    });
    const order = readingOrder(rows); rows.forEach((r, k) => { r.number = order.indexOf(k) + 1; });
    // which boxes need a new crop: new ones, and ones that moved or changed size
    const same = (r, old) => old && Math.abs(Number(old.x) - r.x) < 1e-6 && Math.abs(Number(old.y) - r.y) < 1e-6 && Math.abs(Number(old.w) - r.w) < 1e-6 && Math.abs(Number(old.h) - r.h) < 1e-6 && old.crop_file;
    const todo = rows.filter((r) => !same(r, haveById.get(r.id)));
    const made = new Map(); let sourceBuf = null;
    try {
      if (todo.length) {
        if (!board.source_file) throw new HttpError(409, "This board's full-size photo is missing, so cards can't be cut out. Delete the board and upload the photo again.", 'no_source');
        sourceBuf = await readSource(cfg.uploadsDir, board.source_file).catch(() => { throw new HttpError(409, "This board's full-size photo is missing, so cards can't be cut out. Delete the board and upload the photo again.", 'no_source'); });
        for (let i = 0; i < todo.length; i += 6) await Promise.all(todo.slice(i, i + 6).map(async (r) => { const c = await makeCrop(sourceBuf, board.width, board.height, r); made.set(r, { file: await saveFiles(cfg.uploadsDir, c), width: c.width, height: c.height, bytes: c.full.length }); }));
      }
      const oldFiles = [], oldImages = []; let removedFiles = [];
      await withTx(pool, async (conn) => {
        await conn.query('SELECT id FROM card_boards WHERE id = ? FOR UPDATE', [id]);
        const keep = new Set(rows.filter((r) => r.id).map((r) => r.id)), gone = have.filter((old) => !keep.has(old.id));
        const goneItems = gone.map((o) => o.item_id).filter(Boolean); if (goneItems.length) removedFiles = await removeCardItems(conn, goneItems);              // refuses if a card being removed has a real claim
        for (const old of gone) { await conn.query('DELETE FROM card_boxes WHERE id = ?', [old.id]); if (old.crop_file) oldFiles.push(old.crop_file); if (old.crop_image_id) oldImages.push(old.crop_image_id); }
        for (const r of rows) {
          const m = made.get(r), old = haveById.get(r.id); let cropFile = old?.crop_file || null, cropImg = old?.crop_image_id || null;
          if (m) {
            const [ins] = await conn.query('INSERT INTO images (filename, mime, width, height, bytes) VALUES (?,?,?,?,?)', [m.file, 'image/webp', m.width, m.height, m.bytes]);
            if (old?.crop_file) oldFiles.push(old.crop_file); if (old?.crop_image_id) oldImages.push(old.crop_image_id); cropFile = m.file; cropImg = ins.insertId;
          }
          if (r.id) await conn.query('UPDATE card_boxes SET number = ?, x = ?, y = ?, w = ?, h = ?, type_id = ?, price = ?, price_override = ?, qty = ?, note = ?, crop_file = ?, crop_image_id = ? WHERE id = ?', [r.number, r.x, r.y, r.w, r.h, r.typeId, r.price, r.override, r.qty, r.note, cropFile, cropImg, r.id]);
          else await conn.query('INSERT INTO card_boxes (board_id, number, x, y, w, h, type_id, price, price_override, qty, note, crop_file, crop_image_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [id, r.number, r.x, r.y, r.w, r.h, r.typeId, r.price, r.override, r.qty, r.note, cropFile, cropImg]);
        }
        if (bundle.status !== 'draft') await syncBundle(conn, cfg.uploadsDir, bundle.id);                      // the real items follow: price, copies, picture, new and removed cards
        if (oldImages.length) await conn.query('DELETE FROM images WHERE id IN (?)', [oldImages]);              // once the items point at the new pictures
        await audit(conn, req.account.id, 'card_boxes.save', 'card_board', id, { cards: rows.length, cropped: todo.length });
      });
      for (const f of [...oldFiles, ...removedFiles]) await removeFiles(cfg.uploadsDir, f);
    } catch (e) { for (const m of made.values()) await removeFiles(cfg.uploadsDir, m.file); throw e; }
    const [boxes] = await pool.query('SELECT * FROM card_boxes WHERE board_id = ? ORDER BY number', [id]);
    res.json({ ok: true, boxes: boxes.map(boxOut), cropped: todo.length });
  }));

  // ── the buyer's side (no login needed to look) ──
  const LIVE = "b.status = 'open' AND b.order_id IS NOT NULL AND go.cancelled_at IS NULL AND (b.closes_on IS NULL OR b.closes_on >= ?)";
  const BUNDLE_COLS = "b.id, b.group_id AS groupId, g.name AS groupName, b.title, b.description, b.on_hand AS onHand, DATE_FORMAT(b.closes_on, '%Y-%m-%d') AS closesOn, b.pay_days AS payDays, b.order_id AS orderId";
  const takenSql = "(SELECT COUNT(*) FROM claims c WHERE c.item_id = x.item_id AND c.status <> 'cancelled')";

  // Groups that have an open bundle, and the open bundles themselves (with how many cards / copies are left). Nothing here says who claimed what.
  app.get('/api/cards', wrap(async (req, res) => {
    const [bundles] = await pool.query(`SELECT ${BUNDLE_COLS} FROM card_bundles b LEFT JOIN artist_groups g ON g.id = b.group_id JOIN group_orders go ON go.id = b.order_id WHERE ${LIVE} ORDER BY b.id DESC`, [todayUK()]);
    const ids = bundles.map((b) => b.id);
    const [counts] = ids.length ? await pool.query(`SELECT cb.bundle_id AS bundleId, COUNT(DISTINCT cb.id) AS boards, COUNT(x.id) AS cards, COALESCE(SUM(x.qty), 0) AS copies, COALESCE(SUM(GREATEST(x.qty - ${takenSql}, 0)), 0) AS remaining FROM card_boards cb LEFT JOIN card_boxes x ON x.board_id = cb.id WHERE cb.bundle_id IN (?) GROUP BY cb.bundle_id`, [ids]) : [[]];
    const [covers] = ids.length ? await pool.query('SELECT cb.bundle_id AS bundleId, i.filename, i.width, i.height FROM card_boards cb JOIN images i ON i.id = cb.image_id WHERE cb.bundle_id IN (?) ORDER BY cb.sort_order, cb.id', [ids]) : [[]];
    const gids = [...new Set(bundles.map((b) => b.groupId).filter(Boolean))];
    const [groups] = gids.length ? await pool.query('SELECT g.id, g.name, im.filename AS file, im.width AS w, im.height AS h FROM artist_groups g LEFT JOIN images im ON im.id = g.cover_image_id WHERE g.is_hidden = 0 AND g.id IN (?) ORDER BY g.sort_order, g.name', [gids]) : [[]];
    const out = bundles.filter((b) => groups.some((g) => g.id === b.groupId)).map((b) => { const c = counts.find((x) => x.bundleId === b.id) || {}, cover = covers.find((x) => x.bundleId === b.id); return { id: b.id, groupId: b.groupId, groupName: b.groupName, title: b.title, description: b.description || '', onHand: !!b.onHand, closesOn: b.closesOn, payDays: b.payDays, boards: Number(c.boards || 0), cards: Number(c.cards || 0), copies: Number(c.copies || 0), left: Number(c.remaining || 0), cover: cover ? imageOut(cover.filename, cover.width, cover.height) : null }; });
    res.json({ groups: groups.map((g) => ({ id: g.id, name: g.name, cover: imageOut(g.file, g.w, g.h), openBundles: out.filter((b) => b.groupId === g.id).length })), bundles: out });
  }));

  // One open bundle: its boards, and every card on them with its place on the photo, price, how many copies are left, its picture, and (only if you're signed in) how many of it YOU have claimed.
  app.get('/api/cards/bundles/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const [[b]] = await pool.query(`SELECT ${BUNDLE_COLS} FROM card_bundles b LEFT JOIN artist_groups g ON g.id = b.group_id JOIN group_orders go ON go.id = b.order_id WHERE b.id = ? AND ${LIVE}`, [id, todayUK()]); if (!b) throw notFound("That bundle isn't open");
    const [boards] = await pool.query('SELECT cb.id, cb.title, cb.width, cb.height, i.filename, i.width AS iw, i.height AS ih FROM card_boards cb LEFT JOIN images i ON i.id = cb.image_id WHERE cb.bundle_id = ? ORDER BY cb.sort_order, cb.id', [id]);
    const [boxes] = await pool.query(`SELECT x.*, ${takenSql} AS taken FROM card_boxes x JOIN card_boards cb ON cb.id = x.board_id WHERE cb.bundle_id = ? ORDER BY x.board_id, x.number`, [id]);
    let mine = new Map();
    if (req.account) {
      const [hs] = await pool.query('SELECT id FROM joiners WHERE account_id = ?', [req.account.id]); const itemIds = boxes.map((x) => x.item_id).filter(Boolean);
      if (hs.length && itemIds.length) { const [rows] = await pool.query("SELECT item_id, COUNT(*) AS n FROM claims WHERE joiner_id IN (?) AND item_id IN (?) AND status <> 'cancelled' GROUP BY item_id", [hs.map((h) => h.id), itemIds]); mine = new Map(rows.map((r) => [r.item_id, Number(r.n)])); }
    }
    res.json({ bundle: { id: b.id, groupId: b.groupId, groupName: b.groupName, title: b.title, description: b.description || '', onHand: !!b.onHand, closesOn: b.closesOn, payDays: b.payDays },
      boards: boards.map((cb) => ({ id: cb.id, title: cb.title, image: imageOut(cb.filename, cb.iw, cb.ih), aspect: cb.width / cb.height,
        boxes: boxes.filter((x) => x.board_id === cb.id).map((x) => ({ id: x.id, itemId: x.item_id, number: x.number, x: Number(x.x), y: Number(x.y), w: Number(x.w), h: Number(x.h), price: Number(x.price), qty: x.qty, left: Math.max(0, x.qty - Number(x.taken)), note: x.note || '', crop: x.crop_file ? urls(x.crop_file) : null, mine: mine.get(x.item_id) || 0 })) })) });
  }));

  // A card bundle's order (and the cards in it) can only be changed from the Cards tab — otherwise the next sync would quietly undo the change.
  const cardsOrder = async (orderId) => !!(await pool.query('SELECT 1 FROM group_orders WHERE id = ? AND is_cards = 1', [orderId]))[0].length;
  const blocked = () => conflict('This is a card bundle — change it from the Cards tab.', 'managed_in_cards');
  app.use('/api/admin/orders/:id', wrap(async (req, res, next) => {
    const id = Number(req.params.id), edit = (req.method === 'PATCH' || req.method === 'DELETE') && (req.path === '/' || req.path === ''), add = req.method === 'POST' && req.path === '/items';
    if ((edit || add) && Number.isSafeInteger(id) && await cardsOrder(id)) throw blocked();
    next();
  }));
  app.use('/api/admin/items/:id', wrap(async (req, res, next) => {
    const id = Number(req.params.id);
    if ((req.method === 'PATCH' || req.method === 'DELETE') && (req.path === '/' || req.path === '') && Number.isSafeInteger(id)) { const [[it]] = await pool.query('SELECT order_id FROM items WHERE id = ?', [id]); if (it && await cardsOrder(it.order_id)) throw blocked(); }
    next();
  }));
}
