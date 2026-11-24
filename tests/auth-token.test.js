/**
 * Unit tests for OAuthToken module (src/auth/token.js)
 * Covers server-side authorization code exchange and OpenID Connect (OIDC) ID token verification.
 * Executed in GitHub Actions runner via Node.js built-in test runner (node --test).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');

function makeJwt(header, payload) {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = Buffer.from('mock-signature-bytes').toString('base64url');
  return `${h}.${p}.${s}`;
}

function makeValidHeader(overrides) {
  return {
    alg: 'RS256',
    typ: 'JWT',
    kid: 'key-id-12345',
    ...overrides
  };
}

function makeValidPayload(overrides) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com',
    aud: 'my-client-id.apps.googleusercontent.com',
    sub: '109876543210987654321',
    email: 'user@example.com',
    email_verified: true,
    nonce: 'expected-nonce-value-12345',
    iat: now - 10,
    exp: now + 3600,
    name: 'Test Member',
    picture: 'https://example.com/avatar.jpg',
    ...overrides
  };
}

function loadOAuthToken(mockFetchHandler, mockLogger) {
  let loggedMessages = [];
  const context = {
    UrlFetchApp: {
      fetch: (url, options) => {
        if (mockFetchHandler) {
          return mockFetchHandler(url, options);
        }
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ id_token: 'default.mock.idtoken' })
        };
      }
    },
    Utilities: {
      base64Decode: (str, _charset) => {
        return Array.from(Buffer.from(str, 'base64'));
      },
      newBlob: (bytes) => ({
        getDataAsString: (_charset) => Buffer.from(bytes).toString('utf8')
      }),
      Charset: {
        UTF_8: 'UTF_8'
      }
    },
    Logger: mockLogger || {
      log: (msg) => { loggedMessages.push(String(msg)); }
    },
    Date: Date,
    JSON: JSON,
    Math: Math,
    String: String,
    Number: Number,
    isNaN: isNaN,
    encodeURIComponent: encodeURIComponent,
    Error: Error
  };

  vm.createContext(context);
  const code = fs.readFileSync('src/auth/token.js', 'utf8');
  vm.runInContext(code, context);

  return {
    OAuthToken: context.OAuthToken,
    loggedMessages
  };
}

test('OAuthToken.exchangeCode successfully exchanges code for ID token using PKCE verifier', () => {
  let capturedUrl = null;
  let capturedOptions = null;

  const validJwt = makeJwt(makeValidHeader(), makeValidPayload());

  const { OAuthToken } = loadOAuthToken((url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        id_token: validJwt,
        access_token: 'secret-access-token',
        expires_in: 3600,
        token_type: 'Bearer'
      })
    };
  });

  const result = OAuthToken.exchangeCode({
    code: 'google-auth-code-123',
    codeVerifier: 'pkce-verifier-abcdef123456',
    clientId: 'my-client-id.apps.googleusercontent.com',
    clientSecret: 'my-client-secret-999',
    redirectUri: 'https://script.google.com/macros/s/app/exec'
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.idToken, validJwt);
  // Verify access_token is NOT exposed in result
  assert.strictEqual(result.access_token, undefined);

  assert.strictEqual(capturedUrl, 'https://oauth2.googleapis.com/token');
  assert.strictEqual(capturedOptions.method, 'post');
  assert.strictEqual(capturedOptions.contentType, 'application/x-www-form-urlencoded');
  assert.strictEqual(capturedOptions.followRedirects, false);

  const payload = capturedOptions.payload;
  assert.ok(payload.includes('code=google-auth-code-123'));
  assert.ok(payload.includes('code_verifier=pkce-verifier-abcdef123456'));
  assert.ok(payload.includes('client_id=my-client-id.apps.googleusercontent.com'));
  assert.ok(payload.includes('client_secret=my-client-secret-999'));
  assert.ok(payload.includes('grant_type=authorization_code'));
  assert.ok(payload.includes('redirect_uri=' + encodeURIComponent('https://script.google.com/macros/s/app/exec')));
});

test('OAuthToken.exchangeCode rejects missing required parameters', () => {
  const { OAuthToken } = loadOAuthToken();

  assert.strictEqual(OAuthToken.exchangeCode(null).error, 'invalid_params');
  assert.strictEqual(OAuthToken.exchangeCode({}).error, 'missing_code');
  assert.strictEqual(OAuthToken.exchangeCode({ code: 'c' }).error, 'missing_code_verifier');
  assert.strictEqual(OAuthToken.exchangeCode({ code: 'c', codeVerifier: 'v' }).error, 'missing_client_id');
  assert.strictEqual(OAuthToken.exchangeCode({ code: 'c', codeVerifier: 'v', clientId: 'id' }).error, 'missing_redirect_uri');
});

test('OAuthToken.exchangeCode safely handles token endpoint HTTP error responses', () => {
  const { OAuthToken, loggedMessages } = loadOAuthToken(() => ({
    getResponseCode: () => 400,
    getContentText: () => JSON.stringify({
      error: 'invalid_grant',
      error_description: 'Bad Request: Code has expired or has already been used'
    })
  }));

  const result = OAuthToken.exchangeCode({
    code: 'expired-code',
    codeVerifier: 'verifier',
    clientId: 'id',
    redirectUri: 'https://example.com/exec'
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error, 'invalid_grant');
  assert.ok(result.errorDescription.includes('Code has expired'));

  // Ensure HTTP status, error, and error_description were logged for diagnostics
  const allLogs = loggedMessages.join(' ');
  assert.ok(allLogs.includes('HTTP status 400'));
  assert.ok(allLogs.includes('invalid_grant'));
  assert.ok(allLogs.includes('Code has expired'));

  // Ensure secret or authorization code was NOT logged
  assert.ok(!allLogs.includes('expired-code'));
});

test('OAuthToken.exchangeCode logs a warning when client_secret is missing or empty', () => {
  const { OAuthToken, loggedMessages } = loadOAuthToken();
  OAuthToken.exchangeCode({
    code: 'some-code',
    codeVerifier: 'some-verifier',
    clientId: 'client-id',
    redirectUri: 'https://example.com/exec'
    // clientSecret omitted
  });

  const allLogs = loggedMessages.join(' ');
  assert.ok(allLogs.includes('client_secret is missing or empty'));
});

test('OAuthToken.exchangeCode handles invalid_request error from Google token endpoint', () => {
  const { OAuthToken, loggedMessages } = loadOAuthToken(() => ({
    getResponseCode: () => 400,
    getContentText: () => JSON.stringify({
      error: 'invalid_request',
      error_description: 'Missing required parameter: client_secret'
    })
  }));

  const result = OAuthToken.exchangeCode({
    code: 'valid-code',
    codeVerifier: 'valid-verifier',
    clientId: 'valid-client-id',
    redirectUri: 'https://example.com/exec'
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error, 'invalid_request');
  assert.strictEqual(result.errorDescription, 'Missing required parameter: client_secret');

  const allLogs = loggedMessages.join(' ');
  assert.ok(allLogs.includes('error="invalid_request"'));
  assert.ok(allLogs.includes('error_description="Missing required parameter: client_secret"'));
  assert.ok(!allLogs.includes('valid-code'));
  assert.ok(!allLogs.includes('valid-verifier'));
});

test('OAuthToken.exchangeCode handles malformed token response (missing id_token or invalid JSON)', () => {
  // Non-JSON response
  const { OAuthToken: tokenNonJson } = loadOAuthToken(() => ({
    getResponseCode: () => 502,
    getContentText: () => 'Bad Gateway'
  }));

  const res1 = tokenNonJson.exchangeCode({
    code: 'c', codeVerifier: 'v', clientId: 'id', redirectUri: 'u'
  });
  assert.strictEqual(res1.success, false);

  // JSON response without id_token
  const { OAuthToken: tokenMissingIdToken } = loadOAuthToken(() => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ access_token: 'acc-token-only' })
  }));

  const res2 = tokenMissingIdToken.exchangeCode({
    code: 'c', codeVerifier: 'v', clientId: 'id', redirectUri: 'u'
  });
  assert.strictEqual(res2.success, false);
  assert.strictEqual(res2.error, 'missing_id_token');
});

test('OAuthToken.verifyIdToken verifies valid Google ID token claims and returns identity object', () => {
  const { OAuthToken } = loadOAuthToken();
  const clientId = 'my-client-id.apps.googleusercontent.com';
  const nonce = 'expected-nonce-value-12345';

  const jwt = makeJwt(makeValidHeader(), makeValidPayload());

  const result = OAuthToken.verifyIdToken({
    idToken: jwt,
    expectedNonce: nonce,
    expectedClientId: clientId
  });

  assert.strictEqual(result.success, true);
  assert.ok(result.identity);
  assert.strictEqual(result.identity.googleSub, '109876543210987654321');
  assert.strictEqual(result.identity.email, 'user@example.com');
  assert.strictEqual(result.identity.emailVerified, true);
  assert.strictEqual(result.identity.name, 'Test Member');
  assert.strictEqual(result.identity.picture, 'https://example.com/avatar.jpg');
  assert.strictEqual(typeof result.identity.verifiedAt, 'number');

  // Verify no sensitive tokens or secrets are contained in identity object
  assert.strictEqual(result.identity.idToken, undefined);
  assert.strictEqual(result.identity.accessToken, undefined);
  assert.strictEqual(result.identity.refreshToken, undefined);
  assert.strictEqual(result.identity.clientSecret, undefined);
  assert.strictEqual(result.identity.nonce, undefined);
});

test('OAuthToken.verifyIdToken rejects malformed JWT structure or bad Base64URL', () => {
  const { OAuthToken } = loadOAuthToken();
  const clientId = 'id';
  const nonce = 'nonce';

  assert.strictEqual(OAuthToken.verifyIdToken({ idToken: 'not.a.valid.jwt', expectedNonce: nonce, expectedClientId: clientId }).error, 'malformed_jwt');
  assert.strictEqual(OAuthToken.verifyIdToken({ idToken: 'only-one-part', expectedNonce: nonce, expectedClientId: clientId }).error, 'malformed_jwt');
  assert.strictEqual(OAuthToken.verifyIdToken({ idToken: '', expectedNonce: nonce, expectedClientId: clientId }).error, 'missing_id_token');
});

test('OAuthToken.verifyIdToken rejects unsupported algorithm or missing key ID in header', () => {
  const { OAuthToken } = loadOAuthToken();
  const clientId = 'my-client-id.apps.googleusercontent.com';
  const nonce = 'expected-nonce-value-12345';

  // Unsupported algorithm HS256
  const jwtHs = makeJwt(makeValidHeader({ alg: 'HS256' }), makeValidPayload());
  assert.strictEqual(OAuthToken.verifyIdToken({ idToken: jwtHs, expectedNonce: nonce, expectedClientId: clientId }).error, 'unsupported_algorithm');

  // Missing kid
  const jwtNoKid = makeJwt({ alg: 'RS256' }, makeValidPayload());
  assert.strictEqual(OAuthToken.verifyIdToken({ idToken: jwtNoKid, expectedNonce: nonce, expectedClientId: clientId }).error, 'missing_kid');
});

test('OAuthToken.verifyIdToken rejects untrusted issuer', () => {
  const { OAuthToken } = loadOAuthToken();
  const clientId = 'my-client-id.apps.googleusercontent.com';
  const nonce = 'expected-nonce-value-12345';

  const jwt = makeJwt(makeValidHeader(), makeValidPayload({ iss: 'https://evil.issuer.com' }));
  const result = OAuthToken.verifyIdToken({ idToken: jwt, expectedNonce: nonce, expectedClientId: clientId });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error, 'invalid_issuer');
});

test('OAuthToken.verifyIdToken accepts both Google issuer variants', () => {
  const { OAuthToken } = loadOAuthToken();
  const clientId = 'my-client-id.apps.googleusercontent.com';
  const nonce = 'expected-nonce-value-12345';

  // Variant 1: https://accounts.google.com
  const jwt1 = makeJwt(makeValidHeader(), makeValidPayload({ iss: 'https://accounts.google.com' }));
  assert.strictEqual(OAuthToken.verifyIdToken({ idToken: jwt1, expectedNonce: nonce, expectedClientId: clientId }).success, true);

  // Variant 2: accounts.google.com
  const jwt2 = makeJwt(makeValidHeader(), makeValidPayload({ iss: 'accounts.google.com' }));
  assert.strictEqual(OAuthToken.verifyIdToken({ idToken: jwt2, expectedNonce: nonce, expectedClientId: clientId }).success, true);
});

test('OAuthToken.verifyIdToken rejects audience mismatch', () => {
  const { OAuthToken } = loadOAuthToken();
  const clientId = 'my-client-id.apps.googleusercontent.com';
  const nonce = 'expected-nonce-value-12345';

  const jwt = makeJwt(makeValidHeader(), makeValidPayload({ aud: 'different-app.apps.googleusercontent.com' }));
  const result = OAuthToken.verifyIdToken({ idToken: jwt, expectedNonce: nonce, expectedClientId: clientId });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error, 'invalid_audience');
});

test('OAuthToken.verifyIdToken validates authorized party (azp) when present', () => {
  const { OAuthToken } = loadOAuthToken();
  const clientId = 'my-client-id.apps.googleusercontent.com';
  const nonce = 'expected-nonce-value-12345';

  // Matching azp succeeds
  const jwtGood = makeJwt(makeValidHeader(), makeValidPayload({ azp: clientId }));
  assert.strictEqual(OAuthToken.verifyIdToken({ idToken: jwtGood, expectedNonce: nonce, expectedClientId: clientId }).success, true);

  // Mismatched azp fails
  const jwtBad = makeJwt(makeValidHeader(), makeValidPayload({ azp: 'rogue-party.apps.googleusercontent.com' }));
  const resBad = OAuthToken.verifyIdToken({ idToken: jwtBad, expectedNonce: nonce, expectedClientId: clientId });
  assert.strictEqual(resBad.success, false);
  assert.strictEqual(resBad.error, 'invalid_authorized_party');
});

test('OAuthToken.verifyIdToken rejects expired token', () => {
  const { OAuthToken } = loadOAuthToken();
  const clientId = 'my-client-id.apps.googleusercontent.com';
  const nonce = 'expected-nonce-value-12345';

  const now = Math.floor(Date.now() / 1000);
  const jwt = makeJwt(makeValidHeader(), makeValidPayload({
    exp: now - 120, // Expired 2 minutes ago (beyond 60s skew allowance)
    iat: now - 3600
  }));

  const result = OAuthToken.verifyIdToken({ idToken: jwt, expectedNonce: nonce, expectedClientId: clientId });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error, 'token_expired');
});

test('OAuthToken.verifyIdToken rejects token issued in the future or too old', () => {
  const { OAuthToken } = loadOAuthToken();
  const clientId = 'my-client-id.apps.googleusercontent.com';
  const nonce = 'expected-nonce-value-12345';
  const now = Math.floor(Date.now() / 1000);

  // Future iat
  const jwtFuture = makeJwt(makeValidHeader(), makeValidPayload({ iat: now + 300 }));
  const resFuture = OAuthToken.verifyIdToken({ idToken: jwtFuture, expectedNonce: nonce, expectedClientId: clientId });
  assert.strictEqual(resFuture.success, false);
  assert.strictEqual(resFuture.error, 'token_issued_in_future');

  // Too old iat (> 10 minutes)
  const jwtOld = makeJwt(makeValidHeader(), makeValidPayload({ iat: now - 800, exp: now + 3000 }));
  const resOld = OAuthToken.verifyIdToken({ idToken: jwtOld, expectedNonce: nonce, expectedClientId: clientId });
  assert.strictEqual(resOld.success, false);
  assert.strictEqual(resOld.error, 'token_too_old');
});

test('OAuthToken.verifyIdToken rejects missing or mismatched nonce', () => {
  const { OAuthToken } = loadOAuthToken();
  const clientId = 'my-client-id.apps.googleusercontent.com';
  const nonce = 'expected-nonce-value-12345';

  // Missing nonce
  const payloadNoNonce = makeValidPayload();
  delete payloadNoNonce.nonce;
  const jwtNoNonce = makeJwt(makeValidHeader(), payloadNoNonce);
  const resNoNonce = OAuthToken.verifyIdToken({ idToken: jwtNoNonce, expectedNonce: nonce, expectedClientId: clientId });
  assert.strictEqual(resNoNonce.success, false);
  assert.strictEqual(resNoNonce.error, 'missing_nonce');

  // Mismatched nonce
  const jwtBadNonce = makeJwt(makeValidHeader(), makeValidPayload({ nonce: 'attacker-injected-nonce' }));
  const resBadNonce = OAuthToken.verifyIdToken({ idToken: jwtBadNonce, expectedNonce: nonce, expectedClientId: clientId });
  assert.strictEqual(resBadNonce.success, false);
  assert.strictEqual(resBadNonce.error, 'nonce_mismatch');
});

test('OAuthToken.verifyIdToken rejects missing subject (sub)', () => {
  const { OAuthToken } = loadOAuthToken();
  const clientId = 'my-client-id.apps.googleusercontent.com';
  const nonce = 'expected-nonce-value-12345';

  const payloadNoSub = makeValidPayload();
  delete payloadNoSub.sub;
  const jwt = makeJwt(makeValidHeader(), payloadNoSub);
  const res = OAuthToken.verifyIdToken({ idToken: jwt, expectedNonce: nonce, expectedClientId: clientId });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, 'missing_sub');
});

test('OAuthToken.verifyIdToken rejects missing email or unverified email', () => {
  const { OAuthToken } = loadOAuthToken();
  const clientId = 'my-client-id.apps.googleusercontent.com';
  const nonce = 'expected-nonce-value-12345';

  // Missing email
  const payloadNoEmail = makeValidPayload();
  delete payloadNoEmail.email;
  const jwtNoEmail = makeJwt(makeValidHeader(), payloadNoEmail);
  const resNoEmail = OAuthToken.verifyIdToken({ idToken: jwtNoEmail, expectedNonce: nonce, expectedClientId: clientId });
  assert.strictEqual(resNoEmail.success, false);
  assert.strictEqual(resNoEmail.error, 'missing_email');

  // email_verified is false
  const jwtUnverified = makeJwt(makeValidHeader(), makeValidPayload({ email_verified: false }));
  const resUnverified = OAuthToken.verifyIdToken({ idToken: jwtUnverified, expectedNonce: nonce, expectedClientId: clientId });
  assert.strictEqual(resUnverified.success, false);
  assert.strictEqual(resUnverified.error, 'unverified_email');
});
