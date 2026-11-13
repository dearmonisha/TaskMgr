// GET /api/health
//
// Tells the app (and you, from a browser) three things it otherwise has to guess:
// is the database reachable, has the schema been applied, and who does the server
// think you are. The old sync had exactly one failure signal — a red banner — so
// "token expired", "offline" and "someone else wrote first" all looked identical.

import { handle, json, identify, currentSeq, resolveMember, UNSYNCED_KINDS } from './_shared.js';

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
      // The client compares these counts against what it holds and re-reads the whole store
      // if the server claims more. Claims against your own list are deliberately withheld, so
      // the honest number to report *to you* is the number you can actually have -- otherwise
      // every poll looks like a device that has fallen behind, and it resyncs forever.
      // The client compares these counts with what it holds and re-reads the whole store if
      // the server claims more. It is never given photo rows, so reporting them would put
      // every device into a permanent resync.
      for (const k of UNSYNCED_KINDS) delete byKind[k];
      if (byKind.giftclaim) {
        const meMember = await resolveMember(env.DB, me.email);
        if (meMember) {
          const rows = await env.DB.prepare("SELECT data FROM items WHERE kind = 'giftclaim' AND gone = 0").all();
          let visible = 0;
          for (const r of rows.results || []) {
            let c; try { c = JSON.parse(r.data); } catch (e) { continue; }
            if (c && c.giftOwnerId !== meMember.id) visible++;
          }
          byKind.giftclaim = visible;
        }
      }
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
