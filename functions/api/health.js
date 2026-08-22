// GET /api/health
//
// Tells the app (and you, from a browser) three things it otherwise has to guess:
// is the database reachable, has the schema been applied, and who does the server
// think you are. The old sync had exactly one failure signal — a red banner — so
// "token expired", "offline" and "someone else wrote first" all looked identical.

import { handle, json, identify, currentSeq } from './_shared.js';

export async function onRequestGet(context) {
  return handle(async () => {
    const { request, env } = context;
    const me = identify(request, env);

    if (!env || !env.DB) {
      return json(
        {
          ok: false,
          code: 'no_db',
          message: 'No D1 binding named "DB" on this Pages project.',
          identity: me
        },
        503
      );
    }

    try {
      const seq = await currentSeq(env.DB);
      const counts = await env.DB.prepare('SELECT kind, COUNT(*) AS n FROM items WHERE gone = 0 GROUP BY kind').all();
      const byKind = {};
      for (const r of counts.results || []) byKind[r.kind] = r.n;
      return json({ ok: true, seq, items: byKind, identity: me });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const missingSchema = /no such table/i.test(msg);
      return json(
        {
          ok: false,
          code: missingSchema ? 'no_schema' : 'db_error',
          message: missingSchema ? 'The database is bound but the schema has not been applied yet. Run schema.sql.' : msg,
          identity: me
        },
        503
      );
    }
  });
}
