// Mirror of errorIsConnectivityRelated (common/net/DownloadSession.ts), the classifier that
// decides whether a failed feed download stamps feed.lastCheckDate — i.e. whether a failing
// feed waits out the 9-minute politeness floor or is retried on every refresh.
//
// Source of truth: LocalAccountRefresher.swift:239-242 stamps lastCheckDate on EVERY download
// outcome unless errorIsConnectivityRelated (LocalAccountRefresher.swift:369-375), which is
// NSURLErrorDomain plus one of exactly four codes: -1001 timedOut, -1004 cannotConnectToHost,
// -1005 networkConnectionLost, -1009 notConnectedToInternet.
//
// Copied to plain JS because the real function imports @kit.NetworkKit, which will not resolve
// on the host. Keep the table below in step with DownloadSession.ts.
const assert = require('assert');

// --- common/net/DownloadSession.ts ------------------------------------------
// @ohos.net.http reports libcurl failures as 2300000 + CURLcode.
const connectivityErrorCodes = [2300007, 2300028, 2300055, 2300056];
const couldNotResolveHostErrorCode = 2300006;

// `hasDefaultNet` stands in for connection.hasDefaultNetSync(); the real one defaults to true
// when the net stack throws, which is the safe side (a broken feed still gets throttled).
function errorIsConnectivityRelated(error, hasDefaultNet) {
  if (error === undefined) return false;
  const code = error.code;
  if (code === undefined) return false;
  if (connectivityErrorCodes.includes(code)) return true;
  return code === couldNotResolveHostErrorCode && !hasDefaultNet;
}

// The caller's rule, so the test pins the behaviour and not just the predicate.
function stampsLastCheckDate(error, hasDefaultNet) {
  return !errorIsConnectivityRelated(error, hasDefaultNet);
}

const err = (code) => ({ code });

// --- the four that mirror the source's list: never stamped ------------------
// Getting any of these wrong penalises a feed for a network problem it did not cause.
assert.strictEqual(errorIsConnectivityRelated(err(2300007), true), true); // COULDNT_CONNECT  -1004
assert.strictEqual(errorIsConnectivityRelated(err(2300028), true), true); // TIMEDOUT         -1001
assert.strictEqual(errorIsConnectivityRelated(err(2300055), true), true); // SEND_ERROR       -1005
assert.strictEqual(errorIsConnectivityRelated(err(2300056), true), true); // RECV_ERROR       -1005
// A timeout is connectivity in the source (-1001 IS on the list) — not a slow-feed penalty.
assert.strictEqual(stampsLastCheckDate(err(2300028), true), false);
// ...and they stay connectivity whether or not the device happens to have a network.
assert.strictEqual(errorIsConnectivityRelated(err(2300007), false), true);
assert.strictEqual(errorIsConnectivityRelated(err(2300028), false), true);

// --- 2300006 COULDNT_RESOLVE_HOST, both directions --------------------------
// THE inversion this whole card is about. URLSession answers -1009 (notConnectedToInternet)
// for an offline device because it consults the network path before resolving; curl only ever
// reports the failed lookup. So DNS failure is connectivity ONLY while there is no default net.
// Network UP -> dead domain -> stamped, exactly as the source does (-1003 cannotFindHost is
// deliberately NOT on its list), so the feed waits out the 9-minute floor like any other.
assert.strictEqual(errorIsConnectivityRelated(err(2300006), true), false);
assert.strictEqual(stampsLastCheckDate(err(2300006), true), true);
// Network DOWN -> the device is offline -> NOT stamped. If this flips, every feed gets
// penalised the moment the phone loses Wi-Fi, which is worse than the bug being fixed.
assert.strictEqual(errorIsConnectivityRelated(err(2300006), false), true);
assert.strictEqual(stampsLastCheckDate(err(2300006), false), false);

// --- deliberately stamped: the feed's own fault, not the network's ----------
// A CHOICE, not an oversight: the source's list has no TLS code either (it reports -1200
// secureConnectionFailed, which errorIsConnectivityRelated does not accept).
assert.strictEqual(stampsLastCheckDate(err(2300035), true), true);  // SSL_CONNECT_ERROR
assert.strictEqual(stampsLastCheckDate(err(2300060), true), true);  // PEER_FAILED_VERIFICATION
// Also A CHOICE: CURLE_GOT_NOTHING is arguably iOS -1005, but a server that accepts a
// connection and then answers nothing is a server fault and deserves the throttle.
assert.strictEqual(stampsLastCheckDate(err(2300052), true), true);  // GOT_NOTHING
// Non-curl BusinessErrors from @ohos.net.http.
assert.strictEqual(stampsLastCheckDate(err(401), true), true);      // param error
assert.strictEqual(stampsLastCheckDate(err(201), true), true);      // permission denied
// ...and none of those become connectivity just because the device went offline.
assert.strictEqual(stampsLastCheckDate(err(2300035), false), true);
assert.strictEqual(stampsLastCheckDate(err(2300052), false), true);

// --- HTTP statuses never arrive here as errors ------------------------------
// 404/500 come through the httpError delegate (LocalAccountRefresher.swift:353-358), which
// stamps unconditionally, and then downloadDidComplete runs with error === undefined.
// A parse failure happens after the stamp. All three must stamp.
assert.strictEqual(stampsLastCheckDate(undefined, true), true);
assert.strictEqual(stampsLastCheckDate(undefined, false), true);
// A plain Error with no numeric code (e.g. one we construct ourselves) is not connectivity.
assert.strictEqual(stampsLastCheckDate(new Error('Unexpected response (not HTTP)'), true), true);
assert.strictEqual(stampsLastCheckDate(new Error('boom'), false), true);

// --- the regression this fixes ----------------------------------------------
// Before the fix nothing on any error path stamped, so a permanently failing feed was
// requested on every single refresh. Every non-connectivity case above must stamp.
for (const code of [2300006, 2300035, 2300052, 2300060, 401, 201]) {
  assert.strictEqual(stampsLastCheckDate(err(code), true), true, 'must stamp: ' + code);
}
// ...and no connectivity case may ever stamp while offline.
for (const code of connectivityErrorCodes.concat([couldNotResolveHostErrorCode])) {
  assert.strictEqual(stampsLastCheckDate(err(code), false), false, 'must not stamp: ' + code);
}

console.log('ConnectivityError.check.js: all assertions passed');
