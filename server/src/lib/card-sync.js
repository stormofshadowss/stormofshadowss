import path from 'node:path';
import sharp from 'sharp';
import { conflict, notFound } from '../errors.js';
import { deleteCatalog } from './delete-catalog.js';

// KEEP A PUBLISHED BUNDLE AND THE REAL ORDER BEHIND IT IN STEP. Once a bundle is published (or closed) it is backed by a group order (is_cards = 1) and each card by an item in it: title "Bundle — Board — #7", the card's price,
// its crop as the picture, purchase_limit = its copies. Everything downstream (claims, payments, the Claims tab, packing, and for cards not on hand the ordering stages) then works on those like any other order.
// Run inside a transaction. Existing claims keep the price they were made at (as with any price edit); a card can't have fewer copies than are already claimed.
export async function syncBundle(conn, dir, bundleId) {
  const [[b]] = await conn.query('SELECT * FROM card_bundles WHERE id = ? FOR UPDATE', [bundleId]); if (!b) throw notFound('No such bundle');
  if (b.status === 'draft') return { synced: false };
  if (!b.group_id) throw conflict('Choose a group for this bundle first — it appears under its group.', 'group_required');
  const [boxes] = await conn.query(
    `SELECT x.*, cb.title AS board_title, cb.sort_order AS board_order FROM card_boxes x JOIN card_boards cb ON cb.id = x.board_id WHERE cb.bundle_id = ? ORDER BY cb.sort_order, cb.id, x.number`, [bundleId]);
  const itemIds = boxes.map((x) => x.item_id).filter(Boolean);
  if (itemIds.length) await conn.query('SELECT id FROM items WHERE id IN (?) ORDER BY id FOR UPDATE', [itemIds]);        // the items first, then the order — the order every claim uses
  const status = b.status === 'open' ? 'open' : 'closed';
  let orderId = b.order_id;
  if (!orderId) {
    const [r] = await conn.query('INSERT INTO group_orders (group_id, title, status, is_private, close_date, is_cards) VALUES (?,?,?,0,?,1)', [b.group_id, b.title, status, b.closes_on]);
    orderId = r.insertId; await conn.query('UPDATE card_bundles SET order_id = ? WHERE id = ?', [orderId, bundleId]);
  } else await conn.query('UPDATE group_orders SET group_id = ?, title = ?, status = ?, close_date = ? WHERE id = ?', [b.group_id, b.title, status, b.closes_on, orderId]);
  let order = 0, created = 0;
  for (const x of boxes) {
    order += 1;
    let imageId = x.crop_image_id;
    if (!imageId && x.crop_file) {                                                                                       // a crop made before it had an `images` row (slice 1)
      const meta = await sharp(path.join(dir, x.crop_file)).metadata().catch(() => null);
      if (meta) { const [ins] = await conn.query('INSERT INTO images (filename, mime, width, height, bytes) VALUES (?,?,?,?,?)', [x.crop_file, 'image/webp', meta.width, meta.height, 0]); imageId = ins.insertId; await conn.query('UPDATE card_boxes SET crop_image_id = ? WHERE id = ?', [imageId, x.id]); }
    }
    const title = `${b.title} — ${x.board_title} — #${x.number}`.slice(0, 160);
    if (!x.item_id) {
      const [r] = await conn.query("INSERT INTO items (order_id, item_type, title, price, image_id, size_bucket, sort_order, description, purchase_limit, limit_scope, price_tbc) VALUES (?, 'normal', ?, ?, ?, 'XS', ?, ?, ?, 'item', 0)", [orderId, title, x.price, imageId || null, order, x.note || null, x.qty]);
      await conn.query('UPDATE card_boxes SET item_id = ? WHERE id = ?', [r.insertId, x.id]); created += 1;
    } else {
      const [[used]] = await conn.query("SELECT COUNT(*) AS n FROM claims WHERE item_id = ? AND status <> 'cancelled'", [x.item_id]);
      if (x.qty < used.n) throw conflict(`Card #${x.number} on “${x.board_title}” already has ${used.n} claimed, so it can't have fewer than ${used.n} cop${used.n === 1 ? 'y' : 'ies'}.`, 'qty_below_claims');
      await conn.query('UPDATE items SET order_id = ?, title = ?, price = ?, image_id = ?, sort_order = ?, description = ?, purchase_limit = ? WHERE id = ?', [orderId, title, x.price, imageId || null, order, x.note || null, x.qty, x.item_id]);
    }
  }
  return { synced: true, orderId, created };
}

// Remove the items behind some cards. Refuses (with the usual explanation) if anyone has a real claim on one; unconfirmed requests simply go with the item. Returns the picture files to delete after the commit.
export async function removeCardItems(conn, itemIds, orderId = null) {
  if (!itemIds.length && !orderId) return [];
  const r = await deleteCatalog(conn, { itemIds, orderId });
  return r.files;
}
