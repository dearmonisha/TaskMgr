// Cloudflare Pages Function: GET /api/ics-proxy?url=<encoded ics url>
//
// Browsers block most cross-site fetches of external calendar (.ics) feeds
// (school sites, Google/Outlook calendar exports, etc. rarely send permissive
// CORS headers). This function runs on Cloudflare's edge, fetches the feed
// server-side (no CORS restriction there), and hands the raw text back to
// the app. It runs on the same domain the app is served from, so it's
// automatically covered by whatever Cloudflare Access policy protects the
// site -- no separate auth setup needed.
//
// Only fetches http(s) URLs, caps response size, and never executes or
// evaluates anything in the fetched content -- it's just proxied text.

export async function onRequestGet(context) {
  const { request } = context;
  const requestUrl = new URL(request.url);
  const target = requestUrl.searchParams.get('url');

  if (!target) {
    return jsonError('Missing "url" query parameter.', 400);
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch (e) {
    return jsonError('That is not a valid URL.', 400);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return jsonError('Only http:// and https:// calendar URLs are supported.', 400);
  }

  let upstream;
  try {
    upstream = await fetch(parsed.toString(), {
      headers: { 'User-Agent': 'FamilyCalendarImporter/1.0 (+cloudflare-pages-function)' },
      redirect: 'follow'
    });
  } catch (err) {
    return jsonError('Could not reach that calendar URL: ' + (err && err.message ? err.message : 'network error'), 502);
  }

  if (!upstream.ok) {
    return jsonError('The calendar feed responded with an error (HTTP ' + upstream.status + ').', 502);
  }

  const text = await upstream.text();

  if (text.length > 4_000_000) {
    return jsonError('That calendar feed is too large to import.', 502);
  }
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    return jsonError('That URL did not return a valid iCalendar (.ics) file.', 502);
  }

  return new Response(text, {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: { 'content-type': 'application/json' }
  });
}
