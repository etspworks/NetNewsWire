// Mirror of EntryAbility.readFeedSubscription — the `feed:`/`feeds:` scheme test, plus
// normalizedURL (common/util/Urls.ts) and mayBeURL (pages/AddFeedViewControllerPage.ets)
// exactly as it calls them — in plain JS so it runs without a device. The delegate side
// imports ohos kits that will not resolve on the host, hence the copy.
const assert = require('assert');

// --- common/util/Strings.ts -------------------------------------------------
function trimmingWhitespace(s) {
  return s.replace(/^[\s ]+|[\s ]+$/g, '');
}

function strippingPrefix(s, prefix, caseSensitive = false) {
  if (caseSensitive) return s.startsWith(prefix) ? s.substring(prefix.length) : s;
  return s.toLowerCase().startsWith(prefix.toLowerCase()) ? s.substring(prefix.length) : s;
}

// --- common/util/Urls.ts: normalizedURL (RSCore String.normalizedURL) -------
function normalizedURL(input) {
  let s = trimmingWhitespace(input);
  let wasFeeds = false;
  let lower = s.toLowerCase();

  if (lower.startsWith('feeds:')) {
    wasFeeds = true;
    s = strippingPrefix(s, 'feeds:');
  } else if (lower.startsWith('feed:')) {
    s = strippingPrefix(s, 'feed:');
  }

  if (s.startsWith('//')) s = strippingPrefix(s, '//', true);

  lower = s.toLowerCase();
  if (!lower.startsWith('http')) s = (wasFeeds ? 'https' : 'http') + '://' + s;

  if (s.split('/').length === 3) s = s + '/';
  return s;
}

// --- pages/AddFeedViewControllerPage.ets: mayBeURL -------------------------
function mayBeURL(text) {
  const s = trimmingWhitespace(text);
  if (s.length === 0) return false;
  if (s.indexOf('.') < 0 && s.indexOf('[') < 0 && s.indexOf('localhost') < 0) return false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return true;
}

// --- EntryAbility.readFeedSubscription -------------------------------------
// Returns the string handed to Add Feed as `initialFeed`, or undefined when the link is
// dropped (not ours, or not a URL).
function readFeedSubscription(uri) {
  if (uri === undefined) return undefined;
  const lower = uri.toLowerCase();
  if (!lower.startsWith('feed:') && !lower.startsWith('feeds:')) return undefined;
  const normalized = normalizedURL(uri);
  if (!mayBeURL(normalized)) return undefined;
  return normalized;
}

// --- accepted: the two payload shapes a feed: link actually uses -----------
// `feed://host/path` — the scheme is a wrapper, the payload has no inner scheme.
assert.strictEqual(readFeedSubscription('feed://example.com/rss'), 'http://example.com/rss');
// `feed:https://host/path` — the payload carries its own scheme and must keep it. Getting
// this one wrong is the silent-failure case: http:// on an https-only host.
assert.strictEqual(readFeedSubscription('feed:https://example.com/rss'), 'https://example.com/rss');
assert.strictEqual(readFeedSubscription('feed:http://example.com/rss'), 'http://example.com/rss');
// `feeds:` means TLS when the payload does not say otherwise.
assert.strictEqual(readFeedSubscription('feeds://example.com/rss'), 'https://example.com/rss');
assert.strictEqual(readFeedSubscription('feeds:https://example.com/rss'), 'https://example.com/rss');
// A bare host gets the trailing slash, as RSCore does.
assert.strictEqual(readFeedSubscription('feed://example.com'), 'http://example.com/');
// The scheme is matched case-insensitively; the rest of the link keeps its case.
assert.strictEqual(readFeedSubscription('FEED://Example.com/RSS'), 'http://Example.com/RSS');
// Query and fragment survive untouched — a feed URL may need them.
assert.strictEqual(readFeedSubscription('feed:https://example.com/rss?tag=a#b'),
  'https://example.com/rss?tag=a#b');
// Trailing whitespace is trimmed by normalizedURL, as in the source.
assert.strictEqual(readFeedSubscription('feed://example.com/rss  '), 'http://example.com/rss');

// --- rejected: nothing below may reach the feed finder --------------------
assert.strictEqual(readFeedSubscription(undefined), undefined);       // no uri on the Want
assert.strictEqual(readFeedSubscription('feed://'), undefined);        // empty payload
assert.strictEqual(readFeedSubscription('feed:'), undefined);          // scheme only
assert.strictEqual(readFeedSubscription('feed://   '), undefined);     // whitespace payload
assert.strictEqual(readFeedSubscription('feed:javascript:alert(1)'), undefined); // smuggled scheme
assert.strictEqual(readFeedSubscription('feed://localserver'), undefined);       // no dot, no host
assert.strictEqual(readFeedSubscription('feed://exa mple.com/rss'), undefined);  // embedded space
// LEADING whitespace is not stripped before the scheme test — the source matches on an
// already-parsed absoluteString and so does this, since `want.uri` arrives parsed too.
assert.strictEqual(readFeedSubscription('  feed://example.com/rss'), undefined);

// --- disjoint from readOAuthRedirect: neither branch may claim the other's URI ---
assert.strictEqual(readFeedSubscription('netnewswire://auth/feedly?code=abc'), undefined);
assert.strictEqual(readFeedSubscription('netnewswire://anything'), undefined);
// ...and an OAuth redirect is not reachable from a feed link either: `feed:` is stripped, so
// the result can never be a `netnewswire://auth/feedly` base.
assert.ok(!String(readFeedSubscription('feed://example.com/rss')).startsWith('netnewswire:'));

// --- other schemes registered on nobody's behalf --------------------------
assert.strictEqual(readFeedSubscription('https://example.com/rss'), undefined);
assert.strictEqual(readFeedSubscription('feedback://example.com'), undefined); // prefix, not scheme

console.log('FeedSubscriptionLink.check.js: all assertions passed');
