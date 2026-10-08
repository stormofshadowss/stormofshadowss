import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { MIGRATIONS_DIR } from '../src/migrate.js';

const DB = { host: process.env.TEST_DB_HOST || '127.0.0.1', user: process.env.TEST_DB_USER || 'sos', password: process.env.TEST_DB_PASSWORD || 'sos_pw' };

// What happens to a site that's already running when it's upgraded: apply the older migrations, add real data, then the newer one.
test('upgrading an existing database to the packaging fee keeps its data and gives every existing claim a packaging line', async () => {
  const name = `sos_test_mig_${crypto.randomBytes(3).toString('hex')}`;
  const root = await mysql.createConnection(DB);
  await root.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const conn = await mysql.createConnection({ ...DB, database: name, multipleStatements: true });
  try {
    const run = (f) => conn.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    for (const f of ['001_init.sql', '002_admin_login.sql', '003_handle_linking.sql']) await run(f);
    await conn.query("INSERT INTO joiners (instagram_handle) VALUES ('old_timer'); INSERT INTO artist_groups (name) VALUES ('G');");
    await conn.query("INSERT INTO group_orders (group_id, title) VALUES (1, 'Old GO')");
    await conn.query("INSERT INTO claims (joiner_id, order_id, label, status) VALUES (1, 1, 'Old claim', 'confirmed')");
    await conn.query("INSERT INTO claim_costs (claim_id, category, cost, paid) VALUES (1,'initials',10,10),(1,'ems',3,0),(1,'customs',0,0),(1,'doms',2,2)");
    await conn.query("INSERT INTO credit_ledger (joiner_id, kind, amount, balance_effect, claim_id, category) VALUES (1,'applied',2,-2,1,'doms')");

    await run('004_packaging_fee.sql');

    const [lines] = await conn.query('SELECT category, cost, paid FROM claim_costs WHERE claim_id = 1 ORDER BY FIELD(category,"initials","ems","customs","doms","packaging")');
    assert.deepEqual(lines.map((l) => [l.category, Number(l.cost), Number(l.paid)]), [['initials', 10, 10], ['ems', 3, 0], ['customs', 0, 0], ['doms', 2, 2], ['packaging', 0, 0]], 'old figures untouched, packaging line added empty');
    const [[led]] = await conn.query('SELECT category FROM credit_ledger WHERE id = 1');
    assert.equal(led.category, 'doms', 'existing history keeps its category');
    await conn.query("INSERT INTO claim_costs (claim_id, category, cost) VALUES (1, 'packaging', 1) ON DUPLICATE KEY UPDATE cost = 1");
    const [[c]] = await conn.query("SELECT cost FROM claim_costs WHERE claim_id = 1 AND category = 'packaging'");
    assert.equal(Number(c.cost), 1, 'the new category is writable');
    const [cols] = await conn.query("SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND ((table_name='parcels' AND column_name='packaging_total') OR (table_name='parcel_items' AND column_name='packaging_share'))");
    assert.equal(cols.length, 2);
  } finally {
    await conn.end();
    await root.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await root.end();
  }
});

test('upgrading to the packing checklist leaves existing parcels with an empty (unticked) checklist', async () => {
  const name = `sos_test_mig_${crypto.randomBytes(3).toString('hex')}`;
  const root = await mysql.createConnection(DB);
  await root.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const conn = await mysql.createConnection({ ...DB, database: name, multipleStatements: true });
  try {
    const run = (f) => conn.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    for (const f of ['001_init.sql', '002_admin_login.sql', '003_handle_linking.sql', '004_packaging_fee.sql']) await run(f);
    await conn.query("INSERT INTO joiners (instagram_handle) VALUES ('old_timer'); INSERT INTO artist_groups (name) VALUES ('G'); INSERT INTO group_orders (group_id, title) VALUES (1, 'Old GO')");
    await conn.query("INSERT INTO claims (joiner_id, order_id, label, status, pipeline) VALUES (1, 1, 'Old claim', 'confirmed', 'ready to pack / on hand')");
    await conn.query("INSERT INTO parcels (joiner_id, method) VALUES (1, 'UK Royal Mail Tracked 48')");
    await conn.query('INSERT INTO parcel_items (parcel_id, claim_id) VALUES (1, 1)');
    await run('005_packing_checklist.sql');
    const [[pi]] = await conn.query('SELECT packed_at FROM parcel_items WHERE parcel_id = 1');
    const [[p]] = await conn.query('SELECT address_checked_at, lomo_checked_at, bias_checked_at, method FROM parcels WHERE id = 1');
    assert.deepEqual([pi.packed_at, p.address_checked_at, p.lomo_checked_at, p.bias_checked_at], [null, null, null, null]);
    assert.equal(p.method, 'UK Royal Mail Tracked 48', 'existing data untouched');
  } finally { await conn.end(); await root.query(`DROP DATABASE IF EXISTS \`${name}\``); await root.end(); }
});
