// POST /api/import
//
// One-time migration: takes the four old JSON files (tasks.json,
// family-calendar.json, vision-board.json, compass.json) exactly as they were in
// the GitHub repo and explodes them into per-item rows.
//
// Refuses to run against a store that already has data unless ?force=1, so a
// stray second click can't overwrite a week of real edits with a stale export.

import { handle, json, identify, requireDb, readJson, currentSeq, HttpError, NEXT_SEQ } from './_shared.js';

export async function onRequestPost(context) {
  return handle(async () => {
    const { request, env } = context;
    const db = requireDb(env);
    const me = identify(request, env);
    const url = new URL(request.url);
    const force = url.searchParams.get('force') === '1';

    const existing = await db.prepare('SELECT COUNT(*) AS n FROM items').first();
    if (existing && existing.n > 0 && !force) {
      throw new HttpError(
        'This store already holds ' + existing.n + ' items. Re-run with ?force=1 only if you mean to merge an export over it.',
        409,
        'not_empty'
      );
    }

    const body = await readJson(request, 8_000_000);
    const now = new Date().toISOString();
    const rows = [];

    const push = (kind, id, data) => {
      if (!id || !data) return;
      rows.push({ kind, id: String(id), data });
    };

    for (const t of arr(body.tasks)) push('task', t.id, t);

    const cal = body.calendar || {};
    for (const m of arr(cal.family)) push('member', m.id, m);
    for (const e of arr(cal.events)) push('event', e.id, e);
    for (const s of arr(cal.calendarSubscriptions)) push('subscription', s.id, s);

    for (const d of arr(body.dreams)) push('dream', d.id, d);

    const comp = body.compass || {};
    // Profiles are keyed by the kid they belong to rather than by their own id.
    for (const p of arr(comp.profiles)) push('profile', 'profile:' + p.ownerId, p);
    for (const g of arr(comp.goals)) push('goal', g.id, g);
    for (const p of arr(comp.priorities)) push('priority', p.id, p);

    const statements = [];
    for (const r of rows) {
      statements.push(
        db
          .prepare(
            'INSERT INTO items (id, kind, data, seq, updated_at, updated_by, gone) VALUES (?, ?, ?, ' + NEXT_SEQ + ', ?, ?, 0) ' +
              'ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, data=excluded.data, gone=0, seq=' + NEXT_SEQ + ', updated_at=excluded.updated_at, updated_by=excluded.updated_by'
          )
          .bind(r.id, r.kind, JSON.stringify(r.data), now, me.email)
      );
    }

    const metaIn = Object.assign({}, body.meta || {});
    if (cal.homeTimezone) metaIn.homeTimezone = cal.homeTimezone;
    for (const [key, value] of Object.entries(metaIn)) {
      if (value === undefined) continue;
      statements.push(
        db
          .prepare(
            'INSERT INTO meta (key, value, seq, updated_at, updated_by) VALUES (?, ?, ' + NEXT_SEQ + ', ?, ?) ' +
              'ON CONFLICT(key) DO UPDATE SET value=excluded.value, seq=' + NEXT_SEQ + ', updated_at=excluded.updated_at, updated_by=excluded.updated_by'
          )
          .bind(key, JSON.stringify(value), now, me.email)
      );
    }

    // Chunked: D1 batches have a statement ceiling, and a big family calendar
    // with a year of imported school events can run to thousands of rows.
    for (let i = 0; i < statements.length; i += 50) {
      await db.batch(statements.slice(i, i + 50));
    }

    return json({
      imported: rows.length,
      meta: Object.keys(metaIn).length,
      seq: await currentSeq(db),
      by: me.email
    });
  });
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}
