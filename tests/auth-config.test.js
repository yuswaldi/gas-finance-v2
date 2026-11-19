/**
 * Unit tests for AuthConfig module (src/auth/config.js)
 * Covers Google OAuth 2.0 Authorization Code Flow configuration,
 * state generation/verification, and URL creation.
 * Executed in GitHub Actions runner via Node.js built-in test runner (node --test).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');

function loadAuthConfig(mockProperties, mockLogger, mockCacheStore, mockScriptApp) {
  const code = fs.readFileSync('src/auth/config.js', 'utf8');
  const cacheStore = mockCacheStore || {};
  let generatedUuidCounter = 1;

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
    ScriptApp: mockScriptApp || {
      getService: () => ({
        getUrl: () => 'https://script.google.com/macros/s/mock-deployment-id/exec'
      })
    },
    Utilities: {
      getUuid: () => 'mock-uuid-' + (generatedUuidCounter++)
    }
  };

  vm.createContext(context);
  vm.runInContext(code, context);
  return context.AuthConfig;
}

test('AuthConfig.getClientId retrieves OAUTH_CLIENT_ID from Script Properties', () => {
  const authConfig = loadAuthConfig({
    OAUTH_CLIENT_ID: '123456789-oauthclient.apps.googleusercontent.com'
  });
  assert.strictEqual(authConfig.getClientId(), '123456789-oauthclient.apps.googleusercontent.com');
  assert.strictEqual(authConfig.getGisClientId(), '123456789-oauthclient.apps.googleusercontent.com');
});

test('AuthConfig.getClientId falls back to GOOGLE_OAUTH_CLIENT_ID and GIS_CLIENT_ID', () => {
  const authConfigFallback1 = loadAuthConfig({
    GOOGLE_OAUTH_CLIENT_ID: '987654321-googleoauth.apps.googleusercontent.com'
  });
  assert.strictEqual(authConfigFallback1.getClientId(), '987654321-googleoauth.apps.googleusercontent.com');

  const authConfigFallback2 = loadAuthConfig({
    GIS_CLIENT_ID: '555666777-gisclient.apps.googleusercontent.com'
  });
  assert.strictEqual(authConfigFallback2.getClientId(), '555666777-gisclient.apps.googleusercontent.com');
});

test('AuthConfig.getClientId trims whitespace and returns empty string if unconfigured', () => {
  const authConfigEmpty = loadAuthConfig({});
  assert.strictEqual(authConfigEmpty.getClientId(), '');

  const authConfigTrim = loadAuthConfig({
    OAUTH_CLIENT_ID: '   trimmed-client-id.apps.googleusercontent.com   '
  });
  assert.strictEqual(authConfigTrim.getClientId(), 'trimmed-client-id.apps.googleusercontent.com');
});

test('AuthConfig.getRedirectUri retrieves OAUTH_REDIRECT_URI from Script Properties', () => {
  const authConfig = loadAuthConfig({
    OAUTH_REDIRECT_URI: 'https://script.google.com/macros/s/custom-dev-id/exec'
  });
  assert.strictEqual(authConfig.getRedirectUri(), 'https://script.google.com/macros/s/custom-dev-id/exec');
});

test('AuthConfig.getRedirectUri falls back to ScriptApp.getService().getUrl()', () => {
  const authConfig = loadAuthConfig({}, null, null, {
    getService: () => ({
      getUrl: () => 'https://script.google.com/macros/s/fallback-deployment/exec'
    })
  });
  assert.strictEqual(authConfig.getRedirectUri(), 'https://script.google.com/macros/s/fallback-deployment/exec');
});

test('AuthConfig.createState generates random state and caches it', () => {
  const cacheStore = {};
  const authConfig = loadAuthConfig({}, null, cacheStore);
  const state = authConfig.createState();

  assert.strictEqual(state, 'mock-uuid-1');
  assert.strictEqual(cacheStore['oauth_state_' + state], 'valid');
});

test('AuthConfig.validateState accepts valid state and consumes it once', () => {
  const cacheStore = {
    'oauth_state_test-token-123': 'valid'
  };
  const authConfig = loadAuthConfig({}, null, cacheStore);

  // First verification: should succeed and consume
  const isValidFirst = authConfig.validateState('test-token-123');
  assert.strictEqual(isValidFirst, true);
  assert.strictEqual(cacheStore['oauth_state_test-token-123'], undefined);

  // Second verification (replay attempt): should fail
  const isValidSecond = authConfig.validateState('test-token-123');
  assert.strictEqual(isValidSecond, false);
});

test('AuthConfig.validateState rejects missing, empty, or unknown state', () => {
  const authConfig = loadAuthConfig({}, null, {});

  assert.strictEqual(authConfig.validateState(''), false);
  assert.strictEqual(authConfig.validateState(null), false);
  assert.strictEqual(authConfig.validateState(undefined), false);
  assert.strictEqual(authConfig.validateState('non-existent-token'), false);
});

test('AuthConfig.getAuthorizationUrl constructs valid Google OAuth 2.0 URL with required parameters', () => {
  const cacheStore = {};
  const authConfig = loadAuthConfig({
    OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    OAUTH_REDIRECT_URI: 'https://script.google.com/macros/s/test-app/exec'
  }, null, cacheStore);

  const authUrl = authConfig.getAuthorizationUrl('explicit-state-token');
  assert.ok(authUrl.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'));

  const parsedUrl = new URL(authUrl);
  assert.strictEqual(parsedUrl.searchParams.get('client_id'), 'test-client-id.apps.googleusercontent.com');
  assert.strictEqual(parsedUrl.searchParams.get('redirect_uri'), 'https://script.google.com/macros/s/test-app/exec');
  assert.strictEqual(parsedUrl.searchParams.get('response_type'), 'code');
  assert.strictEqual(parsedUrl.searchParams.get('scope'), 'openid email profile');
  assert.strictEqual(parsedUrl.searchParams.get('state'), 'explicit-state-token');
  assert.strictEqual(parsedUrl.searchParams.get('prompt'), 'select_account');
  assert.strictEqual(parsedUrl.searchParams.get('access_type'), 'online');
});

test('AuthConfig.getAuthorizationUrl returns empty string if client_id or redirect_uri is missing', () => {
  const authConfigNoClient = loadAuthConfig({
    OAUTH_REDIRECT_URI: 'https://script.google.com/macros/s/test-app/exec'
  }, null, null, { getService: () => ({ getUrl: () => '' }) });
  assert.strictEqual(authConfigNoClient.getAuthorizationUrl(), '');

  const authConfigNoUri = loadAuthConfig({
    OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com'
  }, null, null, { getService: () => ({ getUrl: () => '' }) });
  assert.strictEqual(authConfigNoUri.getAuthorizationUrl(), '');
});

test('AuthConfig.getPublicConfig exposes only non-sensitive configuration', () => {
  const authConfig = loadAuthConfig({
    OAUTH_CLIENT_ID: 'public-client.apps.googleusercontent.com',
    OAUTH_REDIRECT_URI: 'https://script.google.com/macros/s/public-app/exec',
    SECRET_KEY: 'super-secret-value'
  });

  const publicConfig = authConfig.getPublicConfig();
  // Clone VM context object to avoid cross-realm prototype mismatch in deepStrictEqual
  assert.deepStrictEqual({ ...publicConfig }, {
    clientId: 'public-client.apps.googleusercontent.com',
    redirectUri: 'https://script.google.com/macros/s/public-app/exec'
  });
  assert.strictEqual(publicConfig.SECRET_KEY, undefined);
});
