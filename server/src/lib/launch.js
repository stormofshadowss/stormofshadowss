import { HttpError } from '../errors.js';
import { audit } from '../auth.js';

// EVERY table is classified here, so a table added by a future migration can't be forgotten by the reset (a test fails until it is classified).
export const CONFIG_TABLES = ['artist_groups', 'group_members', 'images', 'launch_state', 'payment_methods', 'proxies', 'schema_migrations'];   // your setup: kept (images are pruned to the ones still used)
export const ADMIN_TABLES = ['accounts', 'sessions'];                                                                                           // only the GOM's own rows are kept (or everyone's, with "keep people")
export const PEOPLE_TABLES = ['addresses', 'handle_link_requests', 'handle_proofs', 'joiner_defaults', 'joiners'];                              // people: removed unless "keep people"
export const WIPE_TABLES = ['audit_log', 'box_items', 'boxes', 'cancel_requests', 'claim_costs', 'claims', 'credit_ledger', 'fixed_claims', 'fixed_requests', 'group_orders', 'handle_invites',
  'import_batches', 'import_records', 'item_members', 'item_sets', 'item_variants', 'items', 'leftover_items', 'login_tokens', 'notification_log', 'parcel_companions', 'parcel_items', 'parcels',
  'payment_allocations', 'payments', 'proxy_payment_items', 'proxy_payments', 'set_slots'];                                                      // orders, claims, money, parcels, logs: always removed

export async function launchState(conn) {
  const [[r]] = await conn.query('SELECT launched_at FROM launch_state WHERE id = 1');
  return { live: !!r?.launched_at, launchedAt: r?.launched_at || null };
}
export async function requireNotLive(conn) {
  if ((await launchState(conn)).live) throw new HttpError(403, 'The site is live, so this is switched off for good.', 'launched');
}
// One way, on purpose: once live, resetting and force-deleting test orders can never be used again.
export async function goLive(conn, adminId) {
  await requireNotLive(conn);
  await conn.query('UPDATE launch_state SET launched_at = NOW(3), launched_by = ? WHERE id = 1 AND launched_at IS NULL', [adminId]);
}

// "Reset for launch": removes every test order, claim, payment, parcel and log; keeps your setup (groups, payment methods, proxies) and the GOM login.
// With keepPeople the accounts, handles and delivery details stay too (their orders, payments and credit are gone). Everything happens in one transaction.
// Returns what was removed, plus the picture files to delete once it has committed.
export async function resetForLaunch(conn, { keepPeople, adminId }) {
  await requireNotLive(conn);
  const count = async (sql) => (await conn.query(sql))[0][0].n;
  const removed = {
    orders: await count('SELECT COUNT(*) AS n FROM group_orders'), items: await count('SELECT COUNT(*) AS n FROM items'), claims: await count('SELECT COUNT(*) AS n FROM claims'),
    payments: await count('SELECT COUNT(*) AS n FROM payments'), parcels: await count('SELECT COUNT(*) AS n FROM parcels'),
    people: keepPeople ? 0 : await count('SELECT COUNT(*) AS n FROM joiners'), accounts: keepPeople ? 0 : await count('SELECT COUNT(*) AS n FROM accounts WHERE is_admin = 0'),
  };
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const t of WIPE_TABLES) await conn.query(`DELETE FROM \`${t}\``);
    if (!keepPeople) {
      await conn.query('DELETE FROM sessions WHERE account_id NOT IN (SELECT id FROM accounts WHERE is_admin = 1)');
      for (const t of PEOPLE_TABLES) await conn.query(`DELETE FROM \`${t}\``);
      await conn.query('DELETE FROM accounts WHERE is_admin = 0');
    }
    const [orphans] = await conn.query('SELECT id, filename FROM images WHERE id NOT IN (SELECT cover_image_id FROM artist_groups WHERE cover_image_id IS NOT NULL)');
    if (orphans.length) await conn.query('DELETE FROM images WHERE id IN (?)', [orphans.map((i) => i.id)]);
    removed.pictures = orphans.length;
    await audit(conn, adminId, 'launch.reset', 'site', 1, { keepPeople: !!keepPeople, ...removed });
    return { removed, files: orphans.map((i) => i.filename) };
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}
