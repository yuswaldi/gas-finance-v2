/**
 * Unit tests for AuthConfig module (src/auth/config.js)
 * Executed in GitHub Actions runner via Node.js built-in test runner (node --test)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');

function loadAuthConfig(mockProperties, mockLogger) {
  const code = fs.readFileSync('src/auth/config.js', 'utf8');
  const context = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (mockProperties && mockProperties[key] !== undefined ? mockProperties[key] : null)
      })
    },
    Logger: mockLogger || { log: () => {} }
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context.AuthConfig;
}

test('AuthConfig.getGisClientId retrieves GIS_CLIENT_ID from Script Properties', () => {
  const authConfig = loadAuthConfig({
    GIS_CLIENT_ID: '123456789-mockclient.apps.googleusercontent.com'
  });
  assert.strictEqual(authConfig.getGisClientId(), '123456789-mockclient.apps.googleusercontent.com');
});

test('AuthConfig.getGisClientId falls back to GOOGLE_OAUTH_CLIENT_ID', () => {
  const authConfig = loadAuthConfig({
    GOOGLE_OAUTH_CLIENT_ID: '987654321-fallback.apps.googleusercontent.com'
  });
  assert.strictEqual(authConfig.getGisClientId(), '987654321-fallback.apps.googleusercontent.com');
});

test('AuthConfig.getGisClientId trims whitespace and returns empty string if unconfigured', () => {
  const authConfigEmpty = loadAuthConfig({});
  assert.strictEqual(authConfigEmpty.getGisClientId(), '');

  const authConfigTrim = loadAuthConfig({
    GIS_CLIENT_ID: '  trimmed-client-id.apps.googleusercontent.com   '
  });
  assert.strictEqual(authConfigTrim.getGisClientId(), 'trimmed-client-id.apps.googleusercontent.com');
});

test('AuthConfig.getPublicConfig exposes only public configuration', () => {
  const authConfig = loadAuthConfig({
    GIS_CLIENT_ID: 'public-client-id.apps.googleusercontent.com',
    SOME_SECRET_KEY: 'super-secret-value'
  });
  const publicConfig = authConfig.getPublicConfig();
  // Clone VM context object into host context to avoid cross-realm prototype mismatch in deepStrictEqual
  assert.deepStrictEqual({ ...publicConfig }, {
    gisClientId: 'public-client-id.apps.googleusercontent.com'
  });
  assert.strictEqual(publicConfig.SOME_SECRET_KEY, undefined);
});
