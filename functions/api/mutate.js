// POST /api/mutate
//
// Body: { ops: [ { opId, kind, id, data }            -- create or update
//              , { opId, kind, id, gone: true }      -- permanent delete
//              , { opId, meta: "homeTimezone", value } ] }
//
// Every op carries a client-generated opId. If the network drops after the write
// lands but before the response arrives, the client retries the same opId and we
// skip it — without that ledger, the retry would re-apply an old edit on top of
// whatever someone else has since changed. That silent-clobber is exactly the
// bug the old GitHub sync had.

import { handle, json, identify, requireDb, readJson, currentSeq, HttpError, KINDS, META_KEYS, NEXT_SEQ, resolveMember } from './_shared.js';

const MAX_OPS = 500;
const MAX_ITEM_BYTES = 256 * 1024;

export async function onRequestPost(context) {
  return handle(async () => {
    const { request, env } = context;
    const db = requireDb(env);
    const me = identify(request, env);
    const body = await readJson(request);

    const ops = Array.isArray(body.ops) ? body.ops : [];
    if (!ops.length) {
      return json({ seq: await currentSeq(db), applied: [], skipped: [] });
    }
    if (ops.length > MAX_OPS) throw new HttpError('Too many ops in one request (max ' + MAX_OPS + ').', 413, 'too_many_ops');

    for (const op of ops) {
      if (!op || typeof op.opId !== 'string' || !op.opId) throw new HttpError('Every op needs an opId.', 400, 'bad_op');
      if (op.meta !== undefined) {
        if (!META_KEYS.has(op.meta)) throw new HttpError('Unknown meta key: ' + op.meta, 400, 'bad_meta');
        continue;
      }
      if (typeof op.id !== 'string' || !op.id) throw new HttpError('Every item op needs an id.', 400, 'bad_op');
      if (!KINDS.has(op.kind)) throw new HttpError('Unknown kind: ' + op.kind, 400, 'bad_kind');
      if (!op.gone) {
        if (op.data === undefined || op.data === null) throw new HttpError('Op ' + op.opId + ' has no data.', 400, 'bad_op');
        if (JSON.stringify(op.data).length > MAX_ITEM_BYTES) throw new HttpError('Item ' + op.id + ' is too large.', 413, 'too_large');
      }
    }

    // ---- gift rules ----
    //
    // Everywhere else this app trusts the client, because everyone can see everything anyway.
    // Gifts are the one place where that isn't true, so the two writes that could unpick the
    // secret are checked here instead of only in the UI: you may only edit your own list, and
    // you may only claim as yourself. A kid who opens the console gets a 403, not a surprise
    // ruined. Enforced only when the signed-in email matches somebody on the roster -- if it
    // doesn't, there's no list of theirs to protect and no identity to impersonate.
    const giftOps = ops.filter((o) => o.kind === 'gift' || o.kind === 'giftclaim');
    let meId = null;
    if (giftOps.length) {
      const meMember = await resolveMember(db, me.email);
      meId = meMember ? meMember.id : null;
    }
    if (meId) {
      // Deletes carry no data, so the row being deleted has to be read to know whose it is.
      const needRow = giftOps.filter((o) => o.gone).map((o) => o.id);
      const existing = {};
      for (let i = 0; i < needRow.length; i += 100) {
        const chunk = needRow.slice(i, i + 100);
        const rows = await db
          .prepare('SELECT id, kind, data FROM items WHERE id IN (' + chunk.map(() => '?').join(',') + ')')
          .bind(...chunk)
          .all();
        for (const r of rows.results || []) {
          try { existing[r.id] = { kind: r.kind, data: JSON.parse(r.data) }; } catch (e) { /* ignore */ }
        }
      }
      for (const op of giftOps) {
        const data = op.gone ? (existing[op.id] && existing[op.id].data) : op.data;
        if (!data) continue;   // deleting a row that isn't there is a no-op, not an attack
        if (op.kind === 'gift' && data.ownerId !== meId) {
          throw new HttpError('That is somebody else\'s gift list.', 403, 'not_your_list');
        }
        if (op.kind === 'giftclaim') {
          if (data.claimerId !== meId) throw new HttpError('You can only claim as yourself.', 403, 'not_your_claim');
          if (data.giftOwnerId === meId) throw new HttpError('You cannot claim from your own list.', 403, 'own_list');
        }
      }
    }

    // Which of these have we already applied? (idempotency)
    const opIds = ops.map((o) => o.opId);
    const seen = new Set();
    for (let i = 0; i < opIds.length; i += 100) {
      const chunk = opIds.slice(i, i + 100);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await db
        .prepare('SELECT op_id FROM ops WHERE op_id IN (' + placeholders + ')')
        .bind(...chunk)
        .all();
      for (const r of rows.results || []) seen.add(r.op_id);
    }

    const fresh = ops.filter((o) => !seen.has(o.opId));
    const now = new Date().toISOString();
    const statements = [];

    for (const op of fresh) {
      if (op.meta !== undefined) {
        statements.push(
          db
            .prepare(
              'INSERT INTO meta (key, value, seq, updated_at, updated_by) VALUES (?, ?, ' + NEXT_SEQ + ', ?, ?) ' +
                'ON CONFLICT(key) DO UPDATE SET value=excluded.value, seq=' + NEXT_SEQ + ', updated_at=excluded.updated_at, updated_by=excluded.updated_by'
            )
            .bind(op.meta, JSON.stringify(op.value === undefined ? null : op.value), now, me.email)
        );
      } else if (op.gone) {
        // Tombstone rather than DELETE: other devices are polling by cursor and
        // would otherwise never learn the row disappeared.
        statements.push(
          db
            .prepare(
              "INSERT INTO items (id, kind, data, seq, updated_at, updated_by, gone) VALUES (?, ?, '{}', " + NEXT_SEQ + ', ?, ?, 1) ' +
                'ON CONFLICT(id) DO UPDATE SET gone=1, data=\'{}\', seq=' + NEXT_SEQ + ', updated_at=excluded.updated_at, updated_by=excluded.updated_by'
            )
            .bind(op.id, op.kind, now, me.email)
        );
      } else {
        statements.push(
          db
            .prepare(
              'INSERT INTO items (id, kind, data, seq, updated_at, updated_by, gone) VALUES (?, ?, ?, ' + NEXT_SEQ + ', ?, ?, 0) ' +
                'ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, data=excluded.data, gone=0, seq=' + NEXT_SEQ + ', updated_at=excluded.updated_at, updated_by=excluded.updated_by'
            )
            .bind(op.id, op.kind, JSON.stringify(op.data), now, me.email)
        );
      }
      statements.push(db.prepare('INSERT OR IGNORE INTO ops (op_id, applied_at) VALUES (?, ?)').bind(op.opId, now));
    }

    // When somebody removes an item from their own list, the claims against it have to go
    // too -- otherwise a giver is left holding a claim on something that no longer exists,
    // and nobody can tell them because the owner must never learn there was a claim at all.
    // They are marked rather than erased so the giver gets told once, on their own screen,
    // that the item was withdrawn. The owner still never sees any of it.
    const removedGifts = fresh.filter((o) => o.kind === 'gift' && o.gone).map((o) => o.id);
    if (removedGifts.length) {
      const claims = await db.prepare("SELECT id, data FROM items WHERE kind = 'giftclaim' AND gone = 0").all();
      for (const r of claims.results || []) {
        let c;
        try { c = JSON.parse(r.data); } catch (e) { continue; }
        if (!c || removedGifts.indexOf(c.giftId) === -1 || c.orphanedAt) continue;
        c.orphanedAt = now;
        c.updatedAt = now;
        statements.push(
          db
            .prepare(
              'UPDATE items SET data = ?, seq = ' + NEXT_SEQ + ', updated_at = ?, updated_by = ? WHERE id = ?'
            )
            .bind(JSON.stringify(c), now, me.email, r.id)
        );
      }
    }

    if (statements.length) await db.batch(statements);

    return json({
      seq: await currentSeq(db),
      applied: fresh.map((o) => o.opId),
      skipped: ops.filter((o) => seen.has(o.opId)).map((o) => o.opId),
      by: me.email
    });
  });
}
