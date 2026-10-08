import { forbidden, bad } from '../errors.js';
import { normalizeHandle } from './handles.js';
import { HttpError } from '../errors.js';

// Which handle is the signed-in person acting as? (Usually they only have one.)
export async function resolveJoiner(pool, req) {
  const [rows] = await pool.query('SELECT id, instagram_handle AS handle FROM joiners WHERE account_id = ? ORDER BY id', [req.account.id]);
  if (!rows.length) throw new HttpError(403, 'Link your Instagram handle first', 'no_handle');
  const wanted = normalizeHandle(req.query.handle || req.body?.handle || '');
  if (wanted) {
    const j = rows.find((r) => r.handle === wanted);
    if (!j) throw forbidden('That handle is not linked to your account');
    return j;
  }
  if (rows.length > 1) throw bad('Which handle? Add ?handle=…', 'handle_required');
  return rows[0];
}
