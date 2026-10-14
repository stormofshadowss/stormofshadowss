// One delivery address per PERSON: their handles all hold the same details (so packing, parcels and everything else that reads a handle's address keep working unchanged).
// The most recently confirmed address among a person's handles is the one they all get. Idempotent — safe to call whenever.
export async function shareAddress(conn, accountId) {
  if (!accountId) return;
  const [handles] = await conn.query('SELECT id FROM joiners WHERE account_id = ? AND account_deleted_at IS NULL ORDER BY id', [accountId]);
  if (handles.length < 2) return;
  const ids = handles.map((h) => h.id);
  const [[latest]] = await conn.query('SELECT full_name, address, email, phone, confirmed_at FROM addresses WHERE joiner_id IN (?) ORDER BY confirmed_at DESC, joiner_id LIMIT 1', [ids]);
  if (!latest) return;
  for (const id of ids) {
    await conn.query(
      `INSERT INTO addresses (joiner_id, full_name, address, email, phone, confirmed_at) VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), address = VALUES(address), email = VALUES(email), phone = VALUES(phone), confirmed_at = VALUES(confirmed_at)`,
      [id, latest.full_name, latest.address, latest.email, latest.phone, latest.confirmed_at]);
  }
}
