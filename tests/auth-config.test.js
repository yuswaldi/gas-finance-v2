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

function makeJwt(header, payload) {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = Buffer.from('mock-signature-bytes').toString('base64url');
  return `${h}.${p}.${s}`;
}

function loadAuthConfig(mockProperties, mockLogger, mockCacheStore, mockScriptApp, mockFetchHandler) {
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
    UrlFetchApp: {
      fetch: (url, options) => {
        if (mockFetchHandler) {
          return mockFetchHandler(url, options);
        }
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ id_token: 'default.id.token' })
        };
      }
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
      base64Decode: (str, _charset) => {
        return Array.from(Buffer.from(str, 'base64'));
      },
      newBlob: (bytes) => ({
        getDataAsString: (_charset) => Buffer.from(bytes).toString('utf8')
      }),
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
    Math: Math,
    Number: Number,
    String: String,
    isNaN: isNaN,
    encodeURIComponent: encodeURIComponent,
    Error: Error
  };

  vm.createContext(context);
  const tokenCode = fs.readFileSync('src/auth/token.js', 'utf8');
  vm.runInContext(tokenCode, context);
  const allowlistCode = fs.readFileSync('src/auth/allowlist.js', 'utf8');
  vm.runInContext(allowlistCode, context);
  const challengeCode = fs.readFileSync('src/auth/challenge.js', 'utf8');
  vm.runInContext(challengeCode, context);
  const configCode = fs.readFileSync('src/auth/config.js', 'utf8');
  vm.runInContext(configCode, context);

  return {
    AuthConfig: context.AuthConfig,
    OAuthChallenge: context.OAuthChallenge,
    OAuthToken: context.OAuthToken,
    AuthAllowlist: context.AuthAllowlist,
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

test('AuthConfig.getClientSecret retrieves secret from Script Properties', () => {
  const { AuthConfig } = loadAuthConfig({
    OAUTH_CLIENT_SECRET: '  GOCSPX-my-super-secret-key  '
  });
  assert.strictEqual(AuthConfig.getClientSecret(), 'GOCSPX-my-super-secret-key');

  const { AuthConfig: authFallback } = loadAuthConfig({
    GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-fallback-secret'
  });
  assert.strictEqual(authFallback.getClientSecret(), 'GOCSPX-fallback-secret');

  const { AuthConfig: authAlias1 } = loadAuthConfig({
    CLIENT_SECRET: 'GOCSPX-alias1-secret'
  });
  assert.strictEqual(authAlias1.getClientSecret(), 'GOCSPX-alias1-secret');

  const { AuthConfig: authAlias2 } = loadAuthConfig({
    GOOGLE_CLIENT_SECRET: 'GOCSPX-alias2-secret'
  });
  assert.strictEqual(authAlias2.getClientSecret(), 'GOCSPX-alias2-secret');

  const { AuthConfig: authAlias3 } = loadAuthConfig({
    GIS_CLIENT_SECRET: 'GOCSPX-alias3-secret'
  });
  assert.strictEqual(authAlias3.getClientSecret(), 'GOCSPX-alias3-secret');

  const { AuthConfig: authAlias4 } = loadAuthConfig({
    OAUTH_SECRET: 'GOCSPX-alias4-secret'
  });
  assert.strictEqual(authAlias4.getClientSecret(), 'GOCSPX-alias4-secret');

  const { AuthConfig: authEmpty } = loadAuthConfig({});
  assert.strictEqual(authEmpty.getClientSecret(), '');
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

test('AuthConfig.validateCallback executes code exchange and ID token verification successfully', () => {
  const clientId = 'test-client-id.apps.googleusercontent.com';
  const redirectUri = 'https://script.google.com/macros/s/test-app/exec';

  let capturedExchangeNonce = null;

  const { AuthConfig, OAuthChallenge } = loadAuthConfig(
    {
      OAUTH_CLIENT_ID: clientId,
      OAUTH_CLIENT_SECRET: 'test-secret',
      OAUTH_REDIRECT_URI: redirectUri,
      ALLOWED_EMAILS: 'user@example.com'
    },
    null,
    {},
    null,
    (_url, options) => {
      // Return ID token matching the challenge nonce
      const now = Math.floor(Date.now() / 1000);
      const jwt = makeJwt(
        { alg: 'RS256', typ: 'JWT', kid: 'test-kid' },
        {
          iss: 'https://accounts.google.com',
          aud: clientId,
          sub: 'google-sub-user-12345',
          email: 'user@example.com',
          email_verified: true,
          nonce: capturedExchangeNonce,
          iat: now - 5,
          exp: now + 3600,
          name: 'Verified Family User'
        }
      );
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ id_token: jwt, access_token: 'secret-acc-token' })
      };
    }
  );

  const challenge = OAuthChallenge.create();
  capturedExchangeNonce = challenge.nonce;

  const callbackResult = AuthConfig.validateCallback({
    code: 'google-auth-code-12345',
    state: challenge.state
  });

  assert.strictEqual(callbackResult.valid, true);
  assert.strictEqual(callbackResult.isError, false);
  assert.strictEqual(callbackResult.accountAuthorized, true);
  assert.strictEqual(callbackResult.code, 'google-auth-code-12345');
  assert.ok(callbackResult.identity);
  assert.strictEqual(callbackResult.identity.googleSub, 'google-sub-user-12345');
  assert.strictEqual(callbackResult.identity.email, 'user@example.com');
  assert.strictEqual(callbackResult.identity.emailVerified, true);
  assert.strictEqual(callbackResult.identity.name, 'Verified Family User');

  // Verify no session token was created (FFM-010 boundary)
  assert.strictEqual(callbackResult.identity.sessionToken, undefined);
  assert.strictEqual(callbackResult.identity.idToken, undefined);
  assert.strictEqual(callbackResult.identity.accessToken, undefined);
});

test('AuthConfig.validateCallback rejects verified identity when not in allowlist', () => {
  const clientId = 'test-client-id.apps.googleusercontent.com';
  const redirectUri = 'https://script.google.com/macros/s/test-app/exec';
  let capturedExchangeNonce = null;

  const { AuthConfig, OAuthChallenge } = loadAuthConfig(
    {
      OAUTH_CLIENT_ID: clientId,
      OAUTH_CLIENT_SECRET: 'test-secret',
      OAUTH_REDIRECT_URI: redirectUri,
      ALLOWED_EMAILS: 'authorized.partner@example.com, authorized.owner@example.com'
    },
    null,
    {},
    null,
    (_url, options) => {
      const now = Math.floor(Date.now() / 1000);
      const jwt = makeJwt(
        { alg: 'RS256', typ: 'JWT', kid: 'test-kid' },
        {
          iss: 'https://accounts.google.com',
          aud: clientId,
          sub: 'attacker-google-sub-99999',
          email: 'unauthorized.stranger@example.com',
          email_verified: true,
          nonce: capturedExchangeNonce,
          iat: now - 5,
          exp: now + 3600,
          name: 'Unauthorized Stranger'
        }
      );
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ id_token: jwt, access_token: 'secret-acc-token' })
      };
    }
  );

  const challenge = OAuthChallenge.create();
  capturedExchangeNonce = challenge.nonce;

  const callbackResult = AuthConfig.validateCallback({
    code: 'google-auth-code-stranger',
    state: challenge.state
  });

  assert.strictEqual(callbackResult.valid, false);
  assert.strictEqual(callbackResult.isError, true);
  assert.strictEqual(callbackResult.errorCode, 'unauthorized_account');
  assert.strictEqual(callbackResult.errorMessage, 'This Google account is not authorized to access the application.');
  assert.strictEqual(callbackResult.accountAuthorized, false);
  assert.strictEqual(callbackResult.identity, null);
});

test('AuthConfig.validateCallback rejects verified identity when allowlist is unconfigured (fail closed)', () => {
  const clientId = 'test-client-id.apps.googleusercontent.com';
  const redirectUri = 'https://script.google.com/macros/s/test-app/exec';
  let capturedExchangeNonce = null;

  const { AuthConfig, OAuthChallenge } = loadAuthConfig(
    {
      OAUTH_CLIENT_ID: clientId,
      OAUTH_CLIENT_SECRET: 'test-secret',
      OAUTH_REDIRECT_URI: redirectUri
      // ALLOWED_EMAILS is omitted / unconfigured
    },
    null,
    {},
    null,
    (_url, _options) => {
      const now = Math.floor(Date.now() / 1000);
      const jwt = makeJwt(
        { alg: 'RS256', typ: 'JWT', kid: 'test-kid' },
        {
          iss: 'https://accounts.google.com',
          aud: clientId,
          sub: 'google-sub-user-12345',
          email: 'valid-user@example.com',
          email_verified: true,
          nonce: capturedExchangeNonce,
          iat: now - 5,
          exp: now + 3600,
          name: 'Valid User'
        }
      );
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ id_token: jwt, access_token: 'secret-acc-token' })
      };
    }
  );

  const challenge = OAuthChallenge.create();
  capturedExchangeNonce = challenge.nonce;

  const callbackResult = AuthConfig.validateCallback({
    code: 'google-auth-code-valid',
    state: challenge.state
  });

  assert.strictEqual(callbackResult.valid, false);
  assert.strictEqual(callbackResult.isError, true);
  assert.strictEqual(callbackResult.errorCode, 'allowlist_unconfigured');
  assert.strictEqual(callbackResult.errorMessage, 'This Google account is not authorized to access the application.');
  assert.strictEqual(callbackResult.accountAuthorized, false);
  assert.strictEqual(callbackResult.identity, null);
});

test('AuthConfig.validateCallback prevents browser identity forgery from bypassing authorization', () => {
  const { AuthConfig } = loadAuthConfig({
    ALLOWED_EMAILS: 'owner@example.com'
  });

  // Attacker submits forged identity object directly in request parameters
  const forgedResult = AuthConfig.validateCallback({
    identity: {
      email: 'owner@example.com',
      emailVerified: true,
      googleSub: '123'
    }
    // Missing valid code and state
  });

  assert.strictEqual(forgedResult.valid, false);
  assert.strictEqual(forgedResult.isError, true);
  // Rejection occurs at code/state validation before any allowlist or identity trust
  assert.strictEqual(forgedResult.errorCode, 'missing_code');
  assert.strictEqual(forgedResult.identity, undefined);
});

test('AuthConfig.validateCallback does not invoke Google Sheets operations or issue sessions', () => {
  const clientId = 'test-client-id.apps.googleusercontent.com';
  const redirectUri = 'https://script.google.com/macros/s/test-app/exec';
  let capturedExchangeNonce = null;

  const { AuthConfig, OAuthChallenge } = loadAuthConfig(
    {
      OAUTH_CLIENT_ID: clientId,
      OAUTH_CLIENT_SECRET: 'test-secret',
      OAUTH_REDIRECT_URI: redirectUri,
      ALLOWED_EMAILS: 'authorized@example.com'
    },
    null,
    {},
    null,
    (_url, _options) => {
      const now = Math.floor(Date.now() / 1000);
      const jwt = makeJwt(
        { alg: 'RS256', typ: 'JWT', kid: 'test-kid' },
        {
          iss: 'https://accounts.google.com',
          aud: clientId,
          sub: 'sub-authorized-123',
          email: 'authorized@example.com',
          email_verified: true,
          nonce: capturedExchangeNonce,
          iat: now - 5,
          exp: now + 3600,
          name: 'Authorized User'
        }
      );
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ id_token: jwt, access_token: 'secret-acc-token' })
      };
    }
  );

  const challenge = OAuthChallenge.create();
  capturedExchangeNonce = challenge.nonce;

  const callbackResult = AuthConfig.validateCallback({
    code: 'google-auth-code-12345',
    state: challenge.state
  });

  assert.strictEqual(callbackResult.valid, true);
  assert.strictEqual(callbackResult.accountAuthorized, true);
  // Verify strict FFM-009 boundaries: no session tokens, no id/access tokens exposed
  assert.strictEqual(callbackResult.identity.sessionToken, undefined);
  assert.strictEqual(callbackResult.identity.sessionId, undefined);
  assert.strictEqual(callbackResult.identity.idToken, undefined);
  assert.strictEqual(callbackResult.identity.accessToken, undefined);
});

test('AuthConfig.validateCallback handles token exchange failure safely', () => {
  const { AuthConfig, OAuthChallenge } = loadAuthConfig(
    {
      OAUTH_CLIENT_ID: 'client-id',
      OAUTH_REDIRECT_URI: 'https://example.com/exec'
    },
    null,
    {},
    null,
    () => ({
      getResponseCode: () => 400,
      getContentText: () => JSON.stringify({ error: 'invalid_grant', error_description: 'Code already used' })
    })
  );

  const challenge = OAuthChallenge.create();
  const result = AuthConfig.validateCallback({
    code: 'bad-code',
    state: challenge.state
  });

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.errorCode, 'invalid_grant');
  assert.ok(result.errorMessage.includes('invalid_grant'));
  assert.ok(result.errorMessage.includes('Code already used'));
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

  // Consume challenge once
  OAuthChallenge.consume(challenge.state);

  // Attempt callback with consumed state (replay)
  const replayResult = AuthConfig.validateCallback({
    code: 'code-123',
    state: challenge.state
  });
  assert.strictEqual(replayResult.valid, false);
  assert.strictEqual(replayResult.errorCode, 'invalid_state');
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
    OAUTH_CLIENT_SECRET: 'super-secret-client-secret',
    OAUTH_REDIRECT_URI: 'https://script.google.com/macros/s/public-app/exec',
    SECRET_KEY: 'super-secret-value'
  });

  const publicConfig = AuthConfig.getPublicConfig();
  assert.deepStrictEqual({ ...publicConfig }, {
    clientId: 'public-client.apps.googleusercontent.com',
    redirectUri: 'https://script.google.com/macros/s/public-app/exec'
  });
  // Client Secret must NEVER be exposed
  assert.strictEqual(publicConfig.OAUTH_CLIENT_SECRET, undefined);
  assert.strictEqual(publicConfig.clientSecret, undefined);
  assert.strictEqual(publicConfig.SECRET_KEY, undefined);
});
