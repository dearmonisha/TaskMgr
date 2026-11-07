// Shared helpers for the sync API (Cloudflare Pages Functions + D1).

export const KINDS = new Set([
  'task', 'event', 'subscription', 'dream', 'goal', 'priority', 'profile', 'member',
  // Event categories used to be a hardcoded list in the app; they're now rows like anything
  // else, so a family can name and colour their own.
  'category',
  // The family message board.
  'message',
  // One Mood Meter check-in per person per day.
  'mood',
  // 75 Medium: the items a person tracks, one row per tracked day, one row per attempt.
  'trackitem', 'trackday', 'trackrun',
  // Gift lists. Two kinds on purpose: a 'gift' is written only by the person whose list it is,
  // a 'giftclaim' only by the person giving it. Keeping them apart is what makes the secret
  // keepable -- the server can withhold every claim from the list's owner without ever
  // withholding part of a row that the owner also writes to (which would round-trip their
  // redacted copy straight back over the top of the real one).
  'gift', 'giftclaim'
]);

export const META_KEYS = new Set(['homeTimezone', 'appTitle', 'appSubtitle']);

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign(
      { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      extraHeaders
    )
  });
}

export function fail(message, status = 400, code) {
  return json({ error: message, code: code || null }, status);
}

/**
 * Who is making this request.
 *
 * Cloudflare Access sits in front of the whole Pages project, so by the time a
 * request reaches this Function it has already been authenticated at the edge.
 * Cloudflare sets Cf-Access-Authenticated-User-Email itself and strips any copy
 * a client tries to send, so the header is trustworthy *as long as Access is
 * actually enforced on this hostname* — which is the same assumption the app's
 * existing /cdn-cgi/access/get-identity call already makes.
 *
 * DEV_IDENTITY lets `wrangler pages dev` run locally where there is no Access.
 * It must never be set in production.
 */
export function identify(request, env) {
  const email = request.headers.get('Cf-Access-Authenticated-User-Email');
  if (email) return { email: email.toLowerCase(), source: 'access' };
  if (env && env.DEV_IDENTITY) return { email: String(env.DEV_IDENTITY).toLowerCase(), source: 'dev' };
  return { email: null, source: 'anonymous' };
}

/**
 * Who is this request, as a family member rather than an email.
 *
 * The roster lives in the same items table (kind 'member'), so one small read resolves it.
 * Returns null when the email matches nobody -- in which case there is no list of theirs to
 * protect, and the caller treats them as seeing everything they'd normally see.
 */
export async function resolveMember(db, email) {
  if (!email) return null;
  const want = String(email).toLowerCase();
  const rows = await db.prepare("SELECT id, data FROM items WHERE kind = 'member' AND gone = 0").all();
  for (const r of rows.results || []) {
    let m;
    try { m = JSON.parse(r.data); } catch (e) { continue; }
    if (m && m.email && String(m.email).toLowerCase() === want) return m;
  }
  return null;
}

/**
 * The one rule the gift module rests on: you never receive a claim against your own list.
 *
 * It applies to everybody, adults included -- Shiva and Monisha asked to be kept in the dark
 * about their own lists too, and a rule with no exceptions is a rule that can't be got wrong.
 * Tombstones carry no data, so they are always passed through: "claim 4f2a is gone" says
 * nothing about which gift it was for.
 */
export function claimIsVisibleTo(row, memberId) {
  if (row.kind !== 'giftclaim') return true;
  if (!memberId || !row.data) return true;
  return row.data.giftOwnerId !== memberId;
}

export function requireDb(env) {
  if (!env || !env.DB) {
    throw new HttpError(
      'The database binding "DB" is missing. Create a D1 database and bind it to this Pages project.',
      500,
      'no_db'
    );
  }
  return env.DB;
}

export class HttpError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function handle(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) return fail(err.message, err.status, err.code);
    return fail('Server error: ' + (err && err.message ? err.message : String(err)), 500, 'server_error');
  }
}

export async function readJson(request, maxBytes = 2_000_000) {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError('Request body too large.', 413, 'too_large');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new HttpError('Request body was not valid JSON.', 400, 'bad_json');
  }
}

/** Highest seq the store has handed out, across both tables. */
export async function currentSeq(db) {
  const row = await db
    .prepare(
      'SELECT MAX(s) AS seq FROM (SELECT MAX(seq) AS s FROM items UNION ALL SELECT MAX(seq) AS s FROM meta)'
    )
    .first();
  return (row && row.seq) || 0;
}

/**
 * SQL fragment that assigns the next seq. Computed inside the statement rather
 * than read-then-written from JS, so two Workers handling simultaneous requests
 * can't both claim the same number.
 */
export const NEXT_SEQ =
  '(SELECT COALESCE(MAX(s),0)+1 FROM (SELECT MAX(seq) AS s FROM items UNION ALL SELECT MAX(seq) AS s FROM meta))';
