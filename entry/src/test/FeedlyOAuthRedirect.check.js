// Mirror of FeedlyAPICaller.authorizationResponseFromRedirect + the state guard in
// FeedlyAccountDelegate.completeOAuthAuthorization, in plain JS so it runs without a device.
const assert = require('assert');

const feedlyRedirectURI = 'netnewswire://auth/feedly';

function isFeedlyRedirectURI(urlString) {
  let end = urlString.length;
  const q = urlString.indexOf('?');
  const h = urlString.indexOf('#');
  if (q >= 0) end = q;
  if (h >= 0 && h < end) end = h;
  let base = urlString.substring(0, end).toLowerCase();
  if (base.endsWith('/')) base = base.substring(0, base.length - 1);
  return base === feedlyRedirectURI;
}

class Cancelled extends Error {}

function responseFrom(urlString) {
  if (!isFeedlyRedirectURI(urlString)) throw new Error('invalidParameter');
  const questionMark = urlString.indexOf('?');
  if (questionMark < 0) throw new Error('invalidParameter');
  let query = urlString.substring(questionMark + 1);
  const hash = query.indexOf('#');
  if (hash >= 0) query = query.substring(0, hash);
  let code, state, error, description;
  for (const pair of query.split('&')) {
    const sep = pair.indexOf('=');
    if (sep < 0) continue;
    const name = decodeURIComponent(pair.substring(0, sep)).toLowerCase();
    const value = decodeURIComponent(pair.substring(sep + 1));
    if (name === 'code') code = value;
    else if (name === 'state') state = value;
    else if (name === 'error') error = value;
    else if (name === 'error_description') description = value;
  }
  if (error === 'access_denied') throw new Cancelled();
  if (error !== undefined && error.length > 0) {
    throw new Error(description !== undefined && description.length > 0 ? description : error);
  }
  if (code === undefined || code.length === 0) throw new Error('invalidParameter');
  return { code, state };
}

function complete(urlString, pendingState) {
  const r = responseFrom(urlString);
  if (pendingState === undefined || pendingState.length === 0 || r.state !== pendingState) {
    throw new Error('stateMismatch');
  }
  return r;
}

const S = 'AAAA-BBBB';

// happy path
assert.deepStrictEqual(complete(`netnewswire://auth/feedly?code=abc123&state=${S}`, S),
  { code: 'abc123', state: S });
// order-independent, extra params, trailing slash, uppercase scheme, fragment
assert.strictEqual(complete(`netnewswire://auth/feedly/?state=${S}&x=1&code=abc#frag`, S).code, 'abc');
assert.strictEqual(complete(`NetNewsWire://AUTH/feedly?code=abc&state=${S}`, S).code, 'abc');
// percent-encoded code survives
assert.strictEqual(complete(`netnewswire://auth/feedly?code=a%2Fb%3Dc&state=${S}`, S).code, 'a/b=c');

// state must match
assert.throws(() => complete(`netnewswire://auth/feedly?code=abc&state=other`, S), /stateMismatch/);
// no state in the callback at all
assert.throws(() => complete(`netnewswire://auth/feedly?code=abc`, S), /stateMismatch/);
// no pending request (replayed callback: the state was already consumed)
assert.throws(() => complete(`netnewswire://auth/feedly?code=abc&state=${S}`, undefined), /stateMismatch/);

// user declined -> cancellation, not an error to show
assert.throws(() => complete(`netnewswire://auth/feedly?error=access_denied&state=${S}`, S),
  (e) => e instanceof Cancelled);
// other server error -> the description wins over the code
assert.throws(() => complete(
  `netnewswire://auth/feedly?error=server_error&error_description=Feedly%20is%20down&state=${S}`, S),
  /Feedly is down/);
assert.throws(() => complete(`netnewswire://auth/feedly?error=server_error&state=${S}`, S),
  /server_error/);

// not our redirect
assert.strictEqual(isFeedlyRedirectURI('feed://example.com/rss?code=abc'), false);
assert.strictEqual(isFeedlyRedirectURI('netnewswire://auth/feedbin?code=abc'), false);
assert.strictEqual(isFeedlyRedirectURI('https://cloud.feedly.com/v3/auth/auth?code=abc'), false);
assert.throws(() => complete('netnewswire://auth/feedbin?code=abc&state=' + S, S), /invalidParameter/);
// our redirect but no query
assert.throws(() => complete('netnewswire://auth/feedly', S), /invalidParameter/);
// empty code
assert.throws(() => complete(`netnewswire://auth/feedly?code=&state=${S}`, S), /invalidParameter/);

console.log('OK — 16 assertions passed');
