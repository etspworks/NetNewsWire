/**
 * Credentials — port of Modules/Secrets/Sources/Secrets/Credentials.swift
 *
 * The raw values are the keychain account-type discriminators the source stores; they are
 * kept verbatim so existing credential records keep resolving.
 */

export enum CredentialsType {
  basic = 'password',
  newsBlurBasic = 'newsBlurBasic',
  newsBlurSessionID = 'newsBlurSessionId',
  readerBasic = 'readerBasic',
  readerAPIKey = 'readerAPIKey',
  oauthAccessToken = 'oauthAccessToken',
  oauthAccessTokenSecret = 'oauthAccessTokenSecret',
  oauthRefreshToken = 'oauthRefreshToken'
}

export interface Credentials {
  type: CredentialsType;
  username: string;
  secret: string;
}

export enum CredentialsErrorKind {
  missingUsername = 'missingUsername',
  missingPassword = 'missingPassword',
  missingAccessToken = 'missingAccessToken',
  missingEndpointURL = 'missingEndpointURL',
  keychainStoreFailure = 'keychainStoreFailure',
  keychainRetrieveFailure = 'keychainRetrieveFailure',
  keychainRemoveFailure = 'keychainRemoveFailure'
}

export function credentialsErrorDescription(kind: CredentialsErrorKind, status: number = 0): string {
  if (kind === CredentialsErrorKind.keychainStoreFailure) {
    return 'Unable to store credentials in the keychain (error ' + status + ').';
  }
  if (kind === CredentialsErrorKind.keychainRetrieveFailure) {
    return 'Unable to retrieve credentials from the keychain (error ' + status + ').';
  }
  if (kind === CredentialsErrorKind.keychainRemoveFailure) {
    return 'Unable to remove credentials from the keychain (error ' + status + ').';
  }
  if (kind === CredentialsErrorKind.missingUsername) {
    return 'Unable to sync account — missing username.';
  }
  if (kind === CredentialsErrorKind.missingPassword) {
    return 'Unable to sync account — missing password.';
  }
  if (kind === CredentialsErrorKind.missingAccessToken) {
    return 'Unable to sync account — missing access token.';
  }
  return 'Unable to sync account — missing endpoint URL.';
}
