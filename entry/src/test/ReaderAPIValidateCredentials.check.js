// Mirror of the FreshRSS / Reader API "Add Account" NEGATIVE paths: what the user is told
// when the credentials are wrong, the API URL points nowhere, or a field is left blank.
//
// Why it exists: the happy path was verified on device against a mock Reader API
// server, but that fixture accepts EVERY username/password, so no negative
// path had ever run. The fixture now has --login-mode
// {reject,forbidden,notfound,noauth,error}; this file pins what each of those answers
// turns into on screen, so the mapping cannot drift without a failing check.
//
// Source of truth:
//   validateCredentials  — common/account/ReaderAPIAccountDelegate.ts:372-415
//   requireOK            — common/account/AccountDelegate.ts:529-544
//   submit()             — pages/ReaderAPIAccountViewControllerPage.ets:216-278
//   iOS counterpart      — iOS/Account/ReaderAPIAccountViewController.swift:152-238
//
// Copied to plain JS because the real code imports @kit.NetworkKit, which will not resolve
// on the host. Keep the tables below in step with those files.
const assert = require('assert');

// --- common/account/AccountDelegate.ts --------------------------------------
const statusIsOK = (status) => status >= 200 && status <= 299;
const isCredentialsErrorStatus = (status) => status === 401 || status === 403;

// requireOK(): the only two shapes validateCredentials can reach it with.
function requireOK(status) {
  if (statusIsOK(status)) return;
  if (status === 429) throw new Error('Too many requests (HTTP 429)');
  throw new Error('HTTP error ' + status);
}

// --- common/account/ReaderAPIAccountDelegate.ts:372 -------------------------
// `body` is the ClientLogin response text; `transportError` stands in for a rejected
// Downloader.send (unreachable host: @ohos.net.http surfaces its own message).
// Returns the credentials, returns undefined for "bad credentials", or throws.
function validateCredentials(status, body, transportError) {
  if (transportError !== undefined) throw transportError;
  if (status === 404) throw new Error('The URL request resulted in a not found error.');
  if (isCredentialsErrorStatus(status)) return undefined;
  requireOK(status);
  let authString;
  for (const line of String(body).split('\n')) {
    const items = line.split('=');
    if (items.length === 2 && items[0] === 'Auth') authString = items[1];
  }
  if (authString === undefined) return undefined;
  return { type: 'readerAPIKey', secret: authString };
}

// --- pages/ReaderAPIAccountViewControllerPage.ets:216 -----------------------
// What submit() puts in the alert. Mirrors the source's action(_:) one for one.
const invalidCombination = 'Invalid username/password combination.';

function messageForLogin(status, body, transportError) {
  let validated;
  try {
    validated = validateCredentials(status, body, transportError);
  } catch (e) {
    return e.message;   // showError((e as Error).message)
  }
  return validated === undefined ? invalidCombination : undefined;  // undefined = account added
}

// validateDataEntry(): FreshRSS additionally needs a parseable API URL.
// `parseURL` stands in for @ohos.url's url.URL.parseURL.
function validateDataEntry(isFreshRSS, username, password, apiUrl) {
  if (isFreshRSS) {
    if (username.length === 0 || password.length === 0 || apiUrl.trim().length === 0) {
      return 'Username, password, and API URL are required.';
    }
    try {
      new URL(apiUrl.trim());
    } catch (e) {
      return 'Invalid API URL.';
    }
    return undefined;
  }
  if (username.length === 0 || password.length === 0) {
    return 'Username and password are required.';
  }
  return undefined;
}

// --- the happy path still passes, so a broken mirror is not mistaken for a fix ---
const good = 'SID=mock\nLSID=mock\nAuth=mock-auth-token-0001\n';
assert.strictEqual(messageForLogin(200, good), undefined);
assert.strictEqual(validateCredentials(200, good).secret, 'mock-auth-token-0001');

// --- wrong username or password: --login-mode reject / forbidden ------------
// Both 401 and 403 must land on the credentials message and NOT on a raw "HTTP error 401":
// requireOK would otherwise leak the status code to the user.
assert.strictEqual(messageForLogin(401, 'Error=BadAuthentication\n'), invalidCombination);
assert.strictEqual(messageForLogin(403, 'Error=BadAuthentication\n'), invalidCombination);

// --- a 200 that carries no Auth= line: --login-mode noauth ------------------
// Same message, not a crash and not a half-created account.
assert.strictEqual(messageForLogin(200, 'SID=mock\nLSID=mock\n'), invalidCombination);
// A malformed line ("Auth=a=b" splits into three items) is not an Auth line either.
assert.strictEqual(messageForLogin(200, 'Auth=a=b\n'), invalidCombination);

// --- a wrong API URL on a live host: --login-mode notfound ------------------
// 404 is checked BEFORE the credentials statuses, so it keeps its own message.
assert.strictEqual(messageForLogin(404, 'Not found\n'),
  'The URL request resulted in a not found error.');

// --- the server is broken rather than the credentials: --login-mode error ---
assert.strictEqual(messageForLogin(500, 'Internal server error\n'), 'HTTP error 500');
assert.strictEqual(messageForLogin(429, ''), 'Too many requests (HTTP 429)');

// --- an unreachable API URL: nothing answers at all -------------------------
// @ohos.net.http rejects; submit() surfaces that message verbatim, as the source surfaces
// error.localizedDescription. The check pins that it is not swallowed into "invalid
// username/password", which would send the user hunting the wrong problem.
const connectionRefused = new Error('Couldn’t connect to server.');
assert.strictEqual(messageForLogin(0, '', connectionRefused), 'Couldn’t connect to server.');

// --- blank fields never reach the network -----------------------------------
assert.strictEqual(validateDataEntry(true, '', 'pw', 'http://10.0.2.2:8099'),
  'Username, password, and API URL are required.');
assert.strictEqual(validateDataEntry(true, 'user', '', 'http://10.0.2.2:8099'),
  'Username, password, and API URL are required.');
assert.strictEqual(validateDataEntry(true, 'user', 'pw', '   '),
  'Username, password, and API URL are required.');
assert.strictEqual(validateDataEntry(true, 'user', 'pw', 'not a url'), 'Invalid API URL.');
assert.strictEqual(validateDataEntry(true, 'user', 'pw', ' http://10.0.2.2:8099 '), undefined);
// The fixed-host variants (Inoreader, The Old Reader, BazQux…) never ask for a URL.
assert.strictEqual(validateDataEntry(false, '', 'pw', ''), 'Username and password are required.');
assert.strictEqual(validateDataEntry(false, 'user', 'pw', ''), undefined);

console.log('ReaderAPIValidateCredentials.check.js: OK');
