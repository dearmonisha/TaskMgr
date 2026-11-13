// Cloudflare Pages Function: GET /api/photo?id=<row id>
//
// The other half of keeping photos out of the sync. /api/state never hands out a photo row,
// so the app asks for one here, by id, only when it is about to put it on screen. The browser
// then caches it like any other image and never asks again -- which is the whole point: a
// picture that is looked at once should not be downloaded onto six phones forever.
//
// The row holds a data: URL written by the app after it has shrunk the picture. This decodes
// that and serves real image bytes, so the browser can cache it properly and the markup stays
// small. It sits behind the same Cloudflare Access policy as everything else, so there is no
// separate auth here -- but it does refuse to serve anything that is not an image, because a
// row id is user-supplied and "fetch me any row as a file" is not a thing worth offering.

import { handle, requireDb, fail } from './_shared.js';

const ALLOWED = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'image/gif': 1 };

export async function onRequestGet(context) {
  return handle(async () => {
    const { request, env } = context;
    const db = requireDb(env);
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return fail('Missing "id".', 400, 'bad_id');

    const row = await db
      .prepare("SELECT data FROM items WHERE id = ? AND kind = 'trackphoto' AND gone = 0")
      .bind(id)
      .first();
    if (!row) return fail('No such photo.', 404, 'not_found');

    let payload;
    try { payload = JSON.parse(row.data); } catch (e) { return fail('That photo is unreadable.', 500, 'bad_row'); }

    const m = /^data:([a-z/+-]+);base64,(.+)$/i.exec((payload && payload.dataUrl) || '');
    if (!m) return fail('That photo is unreadable.', 500, 'bad_row');
    const type = m[1].toLowerCase();
    if (!ALLOWED[type]) return fail('That is not an image.', 415, 'bad_type');

    let bytes;
    try {
      const bin = atob(m[2]);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch (e) {
      return fail('That photo is unreadable.', 500, 'bad_row');
    }

    return new Response(bytes, {
      headers: {
        'content-type': type,
        // A photo row is never edited, only replaced under a new id, so this can be cached
        // hard. That is what stops the second look costing anything at all.
        'cache-control': 'private, max-age=31536000, immutable',
        'content-length': String(bytes.length)
      }
    });
  });
}
