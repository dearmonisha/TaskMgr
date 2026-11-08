// Cloudflare Pages Function: GET /api/link-preview?url=<encoded product url>
//
// The gift list's tile view wants the picture of the thing. A browser can't go and get it:
// reading another site's HTML cross-origin is exactly what CORS forbids, and no shop sends
// permissive headers. So the edge does it, reads the Open Graph tags the page already
// publishes for Facebook and Slack, and hands back the image URL.
//
// Honest limits, because this will not always work:
//   * Plenty of big retailers (Amazon among them) answer bots with a captcha page rather than
//     the product. There are no og: tags on a captcha page, so there is no image to find.
//   * Some hosts refuse to serve their images to another site, so a URL we found can still
//     render as a broken picture.
// Both cases end the same way: no image, the tile falls back to showing the item's name, and
// the owner can paste a picture link themselves. The feature degrades, it doesn't break.
//
// Like ics-proxy.js this sits behind whatever Cloudflare Access policy protects the site, so
// it is not an open proxy to the world -- but it still only fetches http(s), refuses anything
// that looks like a private address, caps what it reads, and never evaluates what comes back.
// It returns a URL as text; it never proxies the image bytes.

const MAX_HTML_BYTES = 512 * 1024;   // og: tags live in <head>; half a megabyte is generous
const TIMEOUT_MS = 8000;

export async function onRequestGet(context) {
  const { request } = context;
  const target = new URL(request.url).searchParams.get('url');
  if (!target) return out({ error: 'Missing "url" query parameter.' }, 400);

  let parsed;
  try { parsed = new URL(target); } catch (e) { return out({ error: 'That is not a valid URL.' }, 400); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return out({ error: 'Only http:// and https:// links are supported.' }, 400);
  }
  if (isPrivateHost(parsed.hostname)) {
    return out({ error: 'That address is not reachable from here.' }, 400);
  }

  // A link straight to a picture needs no scraping.
  if (/\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(parsed.pathname + parsed.search)) {
    return out({ image: parsed.toString(), title: null, site: parsed.hostname, source: 'direct' });
  }

  let html;
  try {
    html = await readSome(parsed.toString());
  } catch (err) {
    return out({ image: null, title: null, site: parsed.hostname, source: 'unreachable',
                 note: err && err.message ? err.message : 'could not reach that page' });
  }

  return out(parsePreview(html, parsed));
}

/**
 * Pull the preview out of a page's markup.
 *
 * Exported and kept free of fetch so it can be tested without a network: this is the part
 * that actually goes wrong. Shops write og: tags in every attribute order going, half of them
 * point at a relative path, and a good few HTML-escape the query string.
 */
export function parsePreview(html, base) {
  const image = absolutise(
    meta(html, 'og:image:secure_url') || meta(html, 'og:image') || meta(html, 'twitter:image')
      || meta(html, 'twitter:image:src') || linkRel(html, 'image_src'),
    base
  );
  const title = meta(html, 'og:title') || tagText(html, 'title');
  return {
    image: image || null,
    title: title ? title.slice(0, 200) : null,
    site: String(base.hostname || '').replace(/^www\./, ''),
    // "blocked" is a more useful thing to say than "no image": it tells the owner that pasting
    // a picture link themselves is the fix, rather than that their link is wrong.
    source: image ? 'og' : (looksBlocked(html) ? 'blocked' : 'none')
  };
}

async function readSome(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        // Honest about what we are. Not pretending to be a person's browser to get around a
        // site that has decided it doesn't want bots.
        'User-Agent': 'FamilyTaskManager/1.0 link-preview (+cloudflare-pages-function)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    if (!res.ok) throw new Error('the page answered HTTP ' + res.status);
    const type = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(type)) throw new Error('that link is not a web page');

    // Read only as far as we need rather than buffering a whole retail page.
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      // The head is all that matters, and it comes first.
      if (total > 96 * 1024 && /<\/head>/i.test(new TextDecoder().decode(concat(chunks)))) break;
    }
    try { await reader.cancel(); } catch (e) { /* already done */ }
    return new TextDecoder('utf-8', { fatal: false }).decode(concat(chunks));
  } finally {
    clearTimeout(timer);
  }
}

function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const outBuf = new Uint8Array(n);
  let i = 0;
  for (const c of chunks) { outBuf.set(c, i); i += c.length; }
  return outBuf;
}

/** <meta property="og:image" content="..."> in either attribute order. */
function meta(html, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp('<meta[^>]+(?:property|name)\\s*=\\s*["\']' + n + '["\'][^>]*?content\\s*=\\s*["\']([^"\']+)["\']', 'i'),
    new RegExp('<meta[^>]+content\\s*=\\s*["\']([^"\']+)["\'][^>]*?(?:property|name)\\s*=\\s*["\']' + n + '["\']', 'i')
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeEntities(m[1].trim());
  }
  return null;
}
function linkRel(html, rel) {
  const m = html.match(new RegExp('<link[^>]+rel\\s*=\\s*["\']' + rel + '["\'][^>]*?href\\s*=\\s*["\']([^"\']+)["\']', 'i'));
  return m && m[1] ? decodeEntities(m[1].trim()) : null;
}
function tagText(html, tag) {
  const m = html.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
  return m && m[1] ? decodeEntities(m[1].replace(/\s+/g, ' ').trim()) : null;
}
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
          .replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** og:image is often a path or protocol-relative; the browser needs an absolute https URL. */
function absolutise(raw, base) {
  if (!raw) return null;
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (isPrivateHost(u.hostname)) return null;
    return u.toString();
  } catch (e) { return null; }
}

/** A captcha or consent wall instead of the product page. */
function looksBlocked(html) {
  return /captcha|are you a human|unusual traffic|access denied|bot detection|enable javascript to continue/i
    .test(html.slice(0, 20000));
}

function isPrivateHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '[::1]' || h === '::1') return true;
  // Plain IPv4 literals in the ranges that never belong on the public internet.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;   // link-local, and cloud metadata
    if (a >= 224) return true;
  }
  return false;
}

function out(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // A product picture does not change often, and the tile view asks on every new link.
      'cache-control': status ? 'no-store' : 'public, max-age=86400'
    }
  });
}
