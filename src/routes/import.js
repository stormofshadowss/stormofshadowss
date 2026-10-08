import express from 'express';
import { z } from 'zod';
import { wrap } from '../lib/http.js';
import { requireAdmin, audit } from '../auth.js';
import { withTx } from '../db.js';
import { bad, conflict, notFound } from '../errors.js';
import { HttpError } from '../errors.js';
import { normalizeHandle, isValidHandle } from '../lib/handles.js';
import { parseNotionClaims, buildPlan, suggestHandle, ImportError, STAGES, DEFAULT_STATUS, statusKey, NO_ORDER_TITLE, DEFAULT_GROUP } from '../lib/notion-import.js';
import { loadExisting, runImport, undoImport } from '../lib/notion-import-db.js';

const MAX_BYTES = 12 * 1024 * 1024;
const json = (s, dflt) => { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } };
const mappingSchema = z.object({
  scope: z.enum(['ongoing', 'history', 'all']).optional(),
  defaultGroup: z.string().trim().min(1).max(80).optional(),
  people: z.record(z.string().max(160), z.string().max(60).nullable()).optional(),
  groups: z.record(z.string().max(200), z.object({ artistGroup: z.string().trim().max(80) }).nullable()).optional(),
  statuses: z.record(z.string().max(100), z.enum([...STAGES, 'cancelled']).nullable()).optional(),
});

// Bringing a Notion "Claims" export onto the site: upload → decide who is who and which artist each order belongs to → preview everything → import → (undo).
export function importRoutes(app, { pool }) {
  const admin = [requireAdmin];
  const rawBody = (req, res, next) => express.raw({ type: () => true, limit: MAX_BYTES })(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') return next(new HttpError(413, `That file is too big — the limit is ${MAX_BYTES / 1024 / 1024} MB.`, 'too_big'));
    next(err);
  });
  const getBatch = async (conn, id, lock = false) => {
    const [[b]] = await conn.query(`SELECT * FROM import_batches WHERE id = ? ${lock ? 'FOR UPDATE' : ''}`, [Number(id)]);
    if (!b) throw notFound('No such import');
    return b;
  };
  const loadRows = (b) => json(b.payload, []);
  const loadMapping = (b) => ({ scope: 'ongoing', ...json(b.mapping, {}) });

  app.post('/api/admin/import/notion', admin, rawBody, wrap(async (req, res) => {
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!text.trim()) throw bad('No file was sent.', 'no_file');
    let parsed;
    try { parsed = parseNotionClaims(text); } catch (e) { if (e instanceof ImportError) throw bad(e.message, 'bad_export'); throw e; }
    const [r] = await pool.query('INSERT INTO import_batches (filename, row_count, payload, mapping, created_by) VALUES (?,?,?,?,?)',
      [String(req.query.filename || '').slice(0, 255) || null, parsed.rows.length, JSON.stringify(parsed.rows), JSON.stringify({ scope: 'ongoing' }), req.account.id]);
    res.status(201).json({ ok: true, id: r.insertId, rows: parsed.rows.length });
  }));

  app.get('/api/admin/import/batches', admin, wrap(async (req, res) => {
    const [rows] = await pool.query('SELECT id, filename, status, row_count, created_at AS createdAt, imported_at AS importedAt, undone_at AS undoneAt, summary FROM import_batches ORDER BY id DESC LIMIT 50');
    res.json({ batches: rows.map((b) => ({ ...b, summary: json(b.summary, null) })) });
  }));

  // everything the wizard needs to show: who is who, which artist each order belongs to, what each status means
  app.get('/api/admin/import/batches/:id', admin, wrap(async (req, res) => {
    const b = await getBatch(pool, req.params.id);
    const rows = loadRows(b), mapping = loadMapping(b);
    const tally = (keyOf) => { const m = new Map(); for (const r of rows) { const k = keyOf(r); if (k) m.set(k, (m.get(k) || 0) + 1); } return m; };
    const people = [...tally((r) => r.joiner)].map(([raw, count]) => {
      const sg = suggestHandle(raw); const rel = new Map();
      for (const r of rows) if (r.joiner === raw && r.relation) rel.set(r.relation, (rel.get(r.relation) || 0) + 1);
      const mapped = mapping.people?.[raw];
      return { raw, count, suggestion: sg.handle, confident: sg.confident, why: sg.why, hint: [...rel].sort((a, c) => c[1] - a[1])[0]?.[0] || '', mapped: mapped === undefined ? null : mapped, needsReview: !sg.confident && mapped === undefined };
    }).sort((a, c) => Number(c.needsReview) - Number(a.needsReview) || c.count - a.count);
    const wanted = [...new Set(people.map((p) => (typeof p.mapped === 'string' ? p.mapped : p.suggestion)).filter(Boolean))];
    const [onSite] = wanted.length ? await pool.query('SELECT instagram_handle AS h, account_id IS NOT NULL AS signedUp FROM joiners WHERE instagram_handle IN (?)', [wanted]) : [[]];
    const siteBy = new Map(onSite.map((x) => [x.h, x.signedUp ? 'signed_up' : 'on_site']));
    for (const p of people) p.onSite = siteBy.get(typeof p.mapped === 'string' ? p.mapped : p.suggestion) || null;
    const [orders] = await pool.query('SELECT title FROM group_orders');
    const have = new Set(orders.map((o) => o.title.toLowerCase()));
    const groups = [...tally((r) => r.go || NO_ORDER_TITLE)].map(([go, count]) => ({ go, count, artistGroup: mapping.groups?.[go]?.artistGroup || '', existsOnSite: have.has(go.toLowerCase()) })).sort((a, c) => a.go.localeCompare(c.go));
    const stat = new Map();                                                      // by status ignoring capitals/spaces, so each real status is one line
    for (const r of rows) { const k = statusKey(r.status) || '(blank)'; const e = stat.get(k) || { raw: r.status || '(blank)', count: 0 }; e.count += 1; stat.set(k, e); }
    const userMap = Object.fromEntries(Object.entries(mapping.statuses || {}).map(([k, v]) => [statusKey(k), v]));
    const statuses = [...stat.entries()].map(([k, e]) => ({ raw: e.raw, count: e.count, mapped: userMap[k] ?? DEFAULT_STATUS[k] ?? null, isDefault: userMap[k] === undefined && !!DEFAULT_STATUS[k] }));
    const [artists] = await pool.query('SELECT name FROM artist_groups ORDER BY name');
    res.json({ id: b.id, filename: b.filename, status: b.status, rowCount: b.row_count, scope: mapping.scope, defaultGroup: mapping.defaultGroup || DEFAULT_GROUP,
      people, groups, statuses, stages: [...STAGES, 'cancelled'], existingArtists: artists.map((a) => a.name), summary: json(b.summary, null) });
  }));

  app.put('/api/admin/import/batches/:id/mapping', admin, wrap(async (req, res) => {
    const b = mappingSchema.parse(req.body);
    for (const [raw, h] of Object.entries(b.people || {})) {
      if (h === null || h === '') continue;
      if (!isValidHandle(normalizeHandle(h))) throw bad(`"${h}" isn't a valid Instagram handle (for "${raw}"). Use letters, numbers, dots and underscores, up to 30.`, 'bad_handle');
    }
    await withTx(pool, async (conn) => {
      const batch = await getBatch(conn, req.params.id, true);
      if (batch.status !== 'draft') throw conflict('This import has already been run, so its settings can no longer be changed.', 'bad_state');
      const m = loadMapping(batch);
      if (b.scope) m.scope = b.scope;
      if (b.defaultGroup) m.defaultGroup = b.defaultGroup;
      for (const [k, section] of [['people', b.people], ['groups', b.groups], ['statuses', b.statuses]]) {
        if (!section) continue;
        m[k] = m[k] || {};
        for (const [name, v] of Object.entries(section)) { if (v === null || (k === 'groups' && !v.artistGroup)) delete m[k][name]; else m[k][name] = k === 'people' ? (v === '' ? '' : normalizeHandle(v)) : v; }
      }
      await conn.query('UPDATE import_batches SET mapping = ? WHERE id = ?', [JSON.stringify(m), batch.id]);
    });
    res.json({ ok: true });
  }));

  const planFor = async (conn, b) => buildPlan(loadRows(b), loadMapping(b), await loadExisting(conn));

  // exactly what would happen — nothing is saved
  app.get('/api/admin/import/batches/:id/preview', admin, wrap(async (req, res) => {
    const b = await getBatch(pool, req.params.id);
    if (b.status !== 'draft') throw conflict('This import has already been run.', 'bad_state');
    const plan = await planFor(pool, b), rep = plan.report;
    res.json({
      ok: rep.ok, counts: rep.counts, byStage: rep.byStage, money: rep.money, skipped: rep.skipped, blockers: rep.blockers,
      warningsTotal: rep.warnings.length, warnings: rep.warnings.slice(0, 100),
      attention: { excessTotal: rep.attention.excess.length, excess: rep.attention.excess.slice(0, 100), negativesTotal: rep.attention.negatives.length, negatives: rep.attention.negatives.slice(0, 100) },
      orders: plan.orders.slice(0, 300).map((o) => ({ title: o.title, artistGroup: o.artistGroup, existing: o.existing, items: o.items.length })),
    });
  }));

  app.post('/api/admin/import/batches/:id/run', admin, wrap(async (req, res) => {
    const out = await withTx(pool, async (conn) => {
      const b = await getBatch(conn, req.params.id, true);
      if (b.status !== 'draft') throw conflict('This import has already been run (or undone). Upload the file again to start a new one.', 'bad_state');
      const plan = await planFor(conn, b);
      if (!plan.report.ok) throw conflict('Some decisions are still needed before this can be imported — the preview lists them.', 'needs_decisions');
      if (!plan.claims.length) throw bad('There is nothing to import with these settings.', 'nothing_to_import');
      const r = await runImport(conn, { batchId: b.id, plan, accountId: req.account.id });
      const rep = plan.report;
      const summary = { scope: plan.scope, ...r, counts: rep.counts, byStage: rep.byStage, money: rep.money, skipped: rep.skipped, excess: rep.attention.excess.slice(0, 200), negatives: rep.attention.negatives.slice(0, 200) };
      await conn.query("UPDATE import_batches SET status = 'imported', imported_at = NOW(3), payload = NULL, summary = ? WHERE id = ?", [JSON.stringify(summary), b.id]);
      await audit(conn, req.account.id, 'import.run', 'import_batch', b.id, { claims: r.made.claims, people: r.made.people });
      return summary;
    });
    res.json({ ok: true, ...out });
  }));

  app.post('/api/admin/import/batches/:id/undo', admin, wrap(async (req, res) => {
    const out = await withTx(pool, async (conn) => {
      const b = await getBatch(conn, req.params.id, true);
      if (b.status !== 'imported') throw conflict(b.status === 'undone' ? 'That import has already been undone.' : 'That import has not been run, so there is nothing to undo.', 'bad_state');
      const r = await undoImport(conn, b.id);
      await conn.query("UPDATE import_batches SET status = 'undone', undone_at = NOW(3), summary = ? WHERE id = ?", [JSON.stringify({ ...json(b.summary, {}), undone: r }), b.id]);
      await audit(conn, req.account.id, 'import.undo', 'import_batch', b.id, r.gone);
      return r;
    });
    res.json({ ok: true, ...out });
  }));

  app.delete('/api/admin/import/batches/:id', admin, wrap(async (req, res) => {
    const b = await getBatch(pool, req.params.id);
    if (b.status === 'imported') throw conflict('This import is live — undo it first.', 'bad_state');
    await pool.query('DELETE FROM import_batches WHERE id = ?', [b.id]);
    res.json({ ok: true });
  }));
}
