// GET /api/state?since=<seq>
//
// The client's only read. With since=0 it returns the whole store; with a cursor
// it returns just what changed, which is what makes 30-second polling cheap
// enough to leave running all day on six devices.

import { handle, json, identify, requireDb, currentSeq, HttpError } from './_shared.js';

export async function onRequestGet(context) {
  return handle(async () => {
    const { request, env } = context;
    const db = requireDb(env);
    const me = identify(request, env);

    const url = new URL(request.url);
    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw ? parseInt(sinceRaw, 10) : 0;
    if (Number.isNaN(since) || since < 0) throw new HttpError('"since" must be a non-negative integer.', 400, 'bad_cursor');

    // Cap a single response so one enormous first load can't blow the Worker's
    // memory or time budget; the client keeps calling until caughtUp is true.
    const LIMIT = 2000;

    const itemRows = await db
      .prepare('SELECT id, kind, data, seq, updated_at, updated_by, gone FROM items WHERE seq > ? ORDER BY seq ASC LIMIT ?')
      .bind(since, LIMIT)
      .all();

    const metaRows = await db
      .prepare('SELECT key, value, seq, updated_at, updated_by FROM meta WHERE seq > ? ORDER BY seq ASC LIMIT ?')
      .bind(since, LIMIT)
      .all();

    const items = (itemRows.results || []).map((r) => ({
      id: r.id,
      kind: r.kind,
      seq: r.seq,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
      gone: !!r.gone,
      data: r.gone ? null : safeParse(r.data)
    }));

    const meta = {};
    for (const r of metaRows.results || []) meta[r.key] = safeParse(r.value);

    const head = await currentSeq(db);
    // The furthest we can honestly claim to have delivered. If either query hit
    // the limit we only advance to the last row actually returned.
    let delivered = head;
    const lastItem = items.length ? items[items.length - 1].seq : 0;
    const lastMeta = (metaRows.results || []).length ? metaRows.results[metaRows.results.length - 1].seq : 0;
    const truncated = items.length >= LIMIT || (metaRows.results || []).length >= LIMIT;
    if (truncated) delivered = Math.max(lastItem, lastMeta);

    return json({
      seq: delivered,
      head,
      caughtUp: !truncated,
      items,
      meta,
      me: { email: me.email }
    });
  });
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}
