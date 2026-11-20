/**
 * Unit tests for AuthConfig module (src/auth/config.js)
 * Covers Google OAuth 2.0 Authorization Code Flow configuration,
 * challenge orchestration, PKCE authorization URL construction, and callback validation.
 * Executed in GitHub Actions runner via Node.js built-in test runner (node --test).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

function loadAuthConfig(mockProperties, mockLogger, mockCacheStore, mockScriptApp) {
  const cacheStore = mockCacheStore || {};
  let generatedUuidCounter = 1;
  let lockAcquired = false;

  const context = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (mockProperties && mockProperties[key] !== undefined ? mockProperties[key] : null)
      })
    },
    Logger: mockLogger || { log: () => {} },
    CacheService: {
      getScriptCache: () => ({
        get: (key) => (cacheStore[key] !== undefined ? cacheStore[key] : null),
        put: (key, val, _ttl) => { cacheStore[key] = String(val); },
        remove: (key) => { delete cacheStore[key]; }
      })
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          if (lockAcquired) return false;
          lockAcquired = true;
          return true;
        },
        releaseLock: () => {
          lockAcquired = false;
        }
      })
    },
    ScriptApp: mockScriptApp || {
      getService: () => ({
        getUrl: () => 'https://script.google.com/macros/s/mock-deployment-id/exec'
      })
    },
    Utilities: {
      getUuid: () => {
        const id = String(generatedUuidCounter++).padStart(4, '0');
        return `00000000-0000-4000-8000-${id}${id}${id}`;
      },
      computeDigest: (_algorithm, value, charset) => {
        const encoding = (charset === 'US_ASCII') ? 'ascii' : 'utf8';
        const hash = crypto.createHash('sha256').update(value, encoding).digest();
        return Array.from(hash).map(b => (b > 127 ? b - 256 : b));
      },
      base64EncodeWebSafe: (bytes) => {
        const unsigned = bytes.map(b => b & 0xFF);
        return Buffer.from(unsigned).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
      },
      DigestAlgorithm: {
        SHA_256: 'SHA_256'
      },
      Charset: {
        US_ASCII: 'US_ASCII',
        UTF_8: 'UTF_8'
      }
    },
    Date: Date,
    JSON: JSON,
    Number: Number,
    String: String,
    isNaN: isNaN,
    Error: Error
  };

  vm.createContext(context);
  const challengeCode = fs.readFileSync('src/auth/challenge.js', 'utf8');
  vm.runInContext(challengeCode, context);
  const configCode = fs.readFileSync('src/auth/config.js', 'utf8');
  vm.runInContext(configCode, context);

  return {
    AuthConfig: context.AuthConfig,
    OAuthChallenge: context.OAuthChallenge,
    cacheStore
  };
}

test('AuthConfig.getClientId retrieves OAUTH_CLIENT_ID from Script Properties', () => {
  const { AuthConfig } = loadAuthConfig({
    OAUTH_CLIENT_ID: '123456789-oauthclient.apps.googleusercontent.com'
  });
  assert.strictEqual(AuthConfig.getClientId(), '123456789-oauthclient.apps.googleusercontent.com');
  assert.strictEqual(AuthConfig.getGisClientId(), '123456789-oauthclient.apps.googleusercontent.com');
});

test('AuthConfig.getClientId falls back to GOOGLE_OAUTH_CLIENT_ID and GIS_CLIENT_ID', () => {
  const { AuthConfig: auth1 } = loadAuthConfig({
    GOOGLE_OAUTH_CLIENT_ID: '987654321-googleoauth.apps.googleusercontent.com'
  });
  assert.strictEqual(auth1.getClientId(), '987654321-googleoauth.apps.googleusercontent.com');

  const { AuthConfig: auth2 } = loadAuthConfig({
    GIS_CLIENT_ID: '555666777-gisclient.apps.googleusercontent.com'
  });
  assert.strictEqual(auth2.getClientId(), '555666777-gisclient.apps.googleusercontent.com');
});

test('AuthConfig.getClientId trims whitespace and returns empty string if unconfigured', () => {
  const { AuthConfig: authEmpty } = loadAuthConfig({});
  assert.strictEqual(authEmpty.getClientId(), '');

  const { AuthConfig: authTrim } = loadAuthConfig({
    OAUTH_CLIENT_ID: '   trimmed-client-id.apps.googleusercontent.com   '
  });
  assert.strictEqual(authTrim.getClientId(), 'trimmed-client-id.apps.googleusercontent.com');
});

test('AuthConfig.getRedirectUri retrieves OAUTH_REDIRECT_URI from Script Properties', () => {
  const { AuthConfig } = loadAuthConfig({
    OAUTH_REDIRECT_URI: 'https://script.google.com/macros/s/custom-dev-id/exec'
  });
  assert.strictEqual(AuthConfig.getRedirectUri(), 'https://script.google.com/macros/s/custom-dev-id/exec');
});

test('AuthConfig.getRedirectUri falls back to ScriptApp.getService().getUrl()', () => {
  const { AuthConfig } = loadAuthConfig({}, null, null, {
    getService: () => ({
      getUrl: () => 'https://script.google.com/macros/s/fallback-deployment/exec'
    })
  });
  assert.strictEqual(AuthConfig.getRedirectUri(), 'https://script.google.com/macros/s/fallback-deployment/exec');
});

test('AuthConfig.createState and validateState provide backwards-compatible challenge handling', () => {
  const { AuthConfig } = loadAuthConfig({});
  const state = AuthConfig.createState();

  assert.ok(state);
  assert.strictEqual(state.length, 64);

  // First validation consumes the state
  assert.strictEqual(AuthConfig.validateState(state), true);
  // Replay attempt fails
  assert.strictEqual(AuthConfig.validateState(state), false);
});

test('AuthConfig.getAuthorizationUrl constructs valid Google OAuth 2.0 URL with state, nonce, and PKCE S256', () => {
  const { AuthConfig } = loadAuthConfig({
    OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    OAUTH_REDIRECT_URI: 'https://script.google.com/macros/s/test-app/exec'
  });

  const authUrl = AuthConfig.getAuthorizationUrl();
  assert.ok(authUrl.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'));

  const parsedUrl = new URL(authUrl);
  assert.strictEqual(parsedUrl.searchParams.get('client_id'), 'test-client-id.apps.googleusercontent.com');
  assert.strictEqual(parsedUrl.searchParams.get('redirect_uri'), 'https://script.google.com/macros/s/test-app/exec');
  assert.strictEqual(parsedUrl.searchParams.get('response_type'), 'code');
  assert.strictEqual(parsedUrl.searchParams.get('scope'), 'openid email profile');
  assert.strictEqual(parsedUrl.searchParams.get('prompt'), 'select_account');
  assert.strictEqual(parsedUrl.searchParams.get('access_type'), 'online');

  // Verify server-generated state, nonce, and PKCE parameters are included
  const state = parsedUrl.searchParams.get('state');
  const nonce = parsedUrl.searchParams.get('nonce');
  const codeChallenge = parsedUrl.searchParams.get('code_challenge');
  const codeChallengeMethod = parsedUrl.searchParams.get('code_challenge_method');

  assert.ok(state, 'Must include state parameter');
  assert.ok(nonce, 'Must include nonce parameter');
  assert.ok(codeChallenge, 'Must include code_challenge parameter');
  assert.strictEqual(codeChallengeMethod, 'S256');

  // Verify code_verifier is NEVER included in URL
  assert.strictEqual(parsedUrl.searchParams.get('code_verifier'), null);
  // Verify client_secret is NEVER included in URL
  assert.strictEqual(parsedUrl.searchParams.get('client_secret'), null);
});

test('AuthConfig.getAuthorizationUrl returns empty string if client_id or redirect_uri is missing', () => {
  const { AuthConfig: noClient } = loadAuthConfig({
    OAUTH_REDIRECT_URI: 'https://script.google.com/macros/s/test-app/exec'
  }, null, null, { getService: () => ({ getUrl: () => '' }) });
  assert.strictEqual(noClient.getAuthorizationUrl(), '');

  const { AuthConfig: noUri } = loadAuthConfig({
    OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com'
  }, null, null, { getService: () => ({ getUrl: () => '' }) });
  assert.strictEqual(noUri.getAuthorizationUrl(), '');
});

test('AuthConfig.validateCallback accepts valid callback and returns challenge data', () => {
  const { AuthConfig, OAuthChallenge } = loadAuthConfig({});
  const challenge = OAuthChallenge.create();

  const callbackResult = AuthConfig.validateCallback({
    code: 'google-auth-code-12345',
    state: challenge.state
  });

  assert.strictEqual(callbackResult.valid, true);
  assert.strictEqual(callbackResult.isError, false);
  assert.strictEqual(callbackResult.code, 'google-auth-code-12345');
  assert.ok(callbackResult.challenge);
  assert.strictEqual(callbackResult.challenge.nonce, challenge.nonce);
  assert.ok(callbackResult.challenge.codeVerifier);
});

test('AuthConfig.validateCallback rejects missing state parameter', () => {
  const { AuthConfig } = loadAuthConfig({});

  const result = AuthConfig.validateCallback({
    code: 'google-auth-code-12345'
    // Missing state
  });

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.errorCode, 'missing_state');
});

test('AuthConfig.validateCallback rejects invalid, unknown, or replayed state', () => {
  const { AuthConfig, OAuthChallenge } = loadAuthConfig({});
  const challenge = OAuthChallenge.create();

  // Unknown state
  const unknownResult = AuthConfig.validateCallback({
    code: 'code-123',
    state: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  });
  assert.strictEqual(unknownResult.valid, false);
  assert.strictEqual(unknownResult.errorCode, 'invalid_state');

  // Valid first consumption
  const first = AuthConfig.validateCallback({
    code: 'code-123',
    state: challenge.state
  });
  assert.strictEqual(first.valid, true);

  // Second consumption (replayed state)
  const second = AuthConfig.validateCallback({
    code: 'code-123',
    state: challenge.state
  });
  assert.strictEqual(second.valid, false);
  assert.strictEqual(second.errorCode, 'invalid_state');
});

test('AuthConfig.validateCallback safely handles Google OAuth denial error with valid state', () => {
  const { AuthConfig, OAuthChallenge } = loadAuthConfig({});
  const challenge = OAuthChallenge.create();

  const errorResult = AuthConfig.validateCallback({
    error: 'access_denied',
    error_description: 'User denied access to the application',
    state: challenge.state
  });

  assert.strictEqual(errorResult.valid, false);
  assert.strictEqual(errorResult.isError, true);
  assert.strictEqual(errorResult.errorCode, 'access_denied');
  assert.ok(errorResult.errorMessage.includes('access was denied'));
  assert.strictEqual(errorResult.challengeConsumed, true);

  // Verify the state was consumed and cannot be replayed
  const replayResult = AuthConfig.validateCallback({
    code: 'some-code',
    state: challenge.state
  });
  assert.strictEqual(replayResult.valid, false);
  assert.strictEqual(replayResult.errorCode, 'invalid_state');
});

test('AuthConfig.validateCallback rejects Google OAuth denial error if state is missing', () => {
  const { AuthConfig } = loadAuthConfig({});

  const errorResult = AuthConfig.validateCallback({
    error: 'access_denied'
    // Missing state
  });

  assert.strictEqual(errorResult.valid, false);
  assert.strictEqual(errorResult.isError, true);
  assert.strictEqual(errorResult.errorCode, 'missing_state');
});

test('AuthConfig.validateCallback rejects malformed request parameters', () => {
  const { AuthConfig } = loadAuthConfig({});

  assert.strictEqual(AuthConfig.validateCallback(null).errorCode, 'invalid_request');
  assert.strictEqual(AuthConfig.validateCallback(undefined).errorCode, 'invalid_request');
  assert.strictEqual(AuthConfig.validateCallback('not-an-object').errorCode, 'invalid_request');
});

test('AuthConfig.getPublicConfig exposes only non-sensitive configuration', () => {
  const { AuthConfig } = loadAuthConfig({
    OAUTH_CLIENT_ID: 'public-client.apps.googleusercontent.com',
    OAUTH_REDIRECT_URI: 'https://script.google.com/macros/s/public-app/exec',
    SECRET_KEY: 'super-secret-value'
  });

  const publicConfig = AuthConfig.getPublicConfig();
  assert.deepStrictEqual({ ...publicConfig }, {
    clientId: 'public-client.apps.googleusercontent.com',
    redirectUri: 'https://script.google.com/macros/s/public-app/exec'
  });
  assert.strictEqual(publicConfig.SECRET_KEY, undefined);
});
