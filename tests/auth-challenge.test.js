/**
 * Unit tests for OAuthChallenge module (src/auth/challenge.js)
 * Covers server-issued OAuth challenge generation, PKCE S256 challenge computation,
 * state hashing, TTL expiration, atomic one-time consumption, and CSRF/replay protection.
 * Executed in GitHub Actions runner via Node.js built-in test runner (node --test).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

function createMockEnvironment(options) {
  const cacheStore = (options && options.cacheStore) || {};
  let uuidCounter = (options && options.initialUuidCounter) || 1;
  let lockAcquired = false;
  const lockFail = options && options.lockFail;
  const lockCallLog = [];

  const context = {
    Utilities: {
      getUuid: () => {
        const id = String(uuidCounter++).padStart(4, '0');
        return `00000000-0000-4000-8000-${id}${id}${id}`;
      },
      computeDigest: (_algorithm, value, charset) => {
        const encoding = (charset === 'US_ASCII') ? 'ascii' : 'utf8';
        const hash = crypto.createHash('sha256').update(value, encoding).digest();
        // Return signed byte array to accurately simulate Apps Script
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
    CacheService: {
      getScriptCache: () => ({
        get: (key) => (cacheStore[key] !== undefined ? cacheStore[key] : null),
        put: (key, val, ttl) => { cacheStore[key] = String(val); cacheStore[`${key}_ttl`] = ttl; },
        remove: (key) => { delete cacheStore[key]; delete cacheStore[`${key}_ttl`]; }
      })
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: (_timeout) => {
          lockCallLog.push('tryLock');
          if (lockFail) return false;
          if (lockAcquired) return false; // Simulated exclusive lock
          lockAcquired = true;
          return true;
        },
        releaseLock: () => {
          lockCallLog.push('releaseLock');
          lockAcquired = false;
        }
      })
    },
    Logger: {
      log: () => {}
    },
    Date: Date,
    JSON: JSON,
    Number: Number,
    String: String,
    isNaN: isNaN,
    Error: Error
  };

  vm.createContext(context);
  const code = fs.readFileSync('src/auth/challenge.js', 'utf8');
  vm.runInContext(code, context);

  return {
    OAuthChallenge: context.OAuthChallenge,
    cacheStore,
    lockCallLog,
    context
  };
}

test('OAuthChallenge.generateToken generates 64-character lowercase hex string with independent entropy', () => {
  const { OAuthChallenge } = createMockEnvironment();
  const token1 = OAuthChallenge.generateToken();
  const token2 = OAuthChallenge.generateToken();

  assert.strictEqual(typeof token1, 'string');
  assert.strictEqual(token1.length, 64, 'Token must be 64 characters (2 UUIDs without hyphens)');
  assert.match(token1, /^[0-9a-f]{64}$/, 'Token must be lowercase hex');
  assert.notStrictEqual(token1, token2, 'Consecutive tokens must be distinct and independent');
});

test('OAuthChallenge.computeCodeChallenge correctly computes S256 challenge matching RFC 7636 Appendix B test vector', () => {
  const { OAuthChallenge } = createMockEnvironment();
  // Official test vector from RFC 7636 Appendix B
  const rfcVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expectedChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  const computedChallenge = OAuthChallenge.computeCodeChallenge(rfcVerifier);
  assert.strictEqual(computedChallenge, expectedChallenge);
  assert.ok(!computedChallenge.includes('='), 'PKCE challenge must not contain padding =');
  assert.strictEqual(computedChallenge.length, 43, 'Base64URL SHA-256 digest is exactly 43 chars');
});

test('OAuthChallenge.computeCodeChallenge throws on invalid or empty verifier', () => {
  const { OAuthChallenge } = createMockEnvironment();
  assert.throws(() => OAuthChallenge.computeCodeChallenge(''), /non-empty string/);
  assert.throws(() => OAuthChallenge.computeCodeChallenge(null), /non-empty string/);
  assert.throws(() => OAuthChallenge.computeCodeChallenge(undefined), /non-empty string/);
});

test('OAuthChallenge.hashState produces consistent 64-character hex SHA-256 digest', () => {
  const { OAuthChallenge } = createMockEnvironment();
  const testState = 'sample-oauth-state-token-value-12345';
  const hash1 = OAuthChallenge.hashState(testState);
  const hash2 = OAuthChallenge.hashState(testState);

  assert.strictEqual(hash1.length, 64);
  assert.match(hash1, /^[0-9a-f]{64}$/);
  assert.strictEqual(hash1, hash2, 'Hash must be deterministic');

  const emptyHash = OAuthChallenge.hashState('');
  assert.strictEqual(emptyHash, '');
});

test('OAuthChallenge.create generates distinct state, nonce, and PKCE verifier, storing record in cache', () => {
  const { OAuthChallenge, cacheStore } = createMockEnvironment();
  const challenge = OAuthChallenge.create();

  // Public return object must contain state, nonce, codeChallenge, codeChallengeMethod, expiresAt
  assert.ok(challenge.state, 'Must contain state');
  assert.ok(challenge.nonce, 'Must contain nonce');
  assert.ok(challenge.codeChallenge, 'Must contain codeChallenge');
  assert.strictEqual(challenge.codeChallengeMethod, 'S256');
  assert.ok(challenge.expiresAt > Date.now(), 'expiresAt must be in the future');

  // Verify codeVerifier is NOT exposed in the public challenge object
  assert.strictEqual(challenge.codeVerifier, undefined, 'codeVerifier must not be exposed in return object');

  // Verify state, nonce, and verifier are independent
  assert.notStrictEqual(challenge.state, challenge.nonce);

  // Verify challenge is stored server-side under hash-derived cache key
  const stateHash = OAuthChallenge.hashState(challenge.state);
  const cacheKey = 'oauth_ch_' + stateHash;
  assert.ok(cacheStore[cacheKey], 'Challenge record must be stored in cache');

  const storedRecord = JSON.parse(cacheStore[cacheKey]);
  assert.strictEqual(storedRecord.stateHash, stateHash);
  assert.strictEqual(storedRecord.nonce, challenge.nonce);
  assert.strictEqual(storedRecord.codeChallenge, challenge.codeChallenge);
  assert.ok(storedRecord.codeVerifier, 'Stored record must contain server-side codeVerifier');
  assert.match(storedRecord.codeVerifier, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(storedRecord.codeVerifier, challenge.state);
  assert.notStrictEqual(storedRecord.codeVerifier, challenge.nonce);
});

test('OAuthChallenge.create enforces TTL bounds (min 300s, max 600s, default 600s)', () => {
  const { OAuthChallenge, cacheStore } = createMockEnvironment();

  // Default TTL
  const chDefault = OAuthChallenge.create();
  const keyDefault = 'oauth_ch_' + OAuthChallenge.hashState(chDefault.state);
  assert.strictEqual(cacheStore[`${keyDefault}_ttl`], 600);

  // Custom TTL within range
  const chCustom = OAuthChallenge.create({ ttlSeconds: 450 });
  const keyCustom = 'oauth_ch_' + OAuthChallenge.hashState(chCustom.state);
  assert.strictEqual(cacheStore[`${keyCustom}_ttl`], 450);

  // Below minimum clamped to 300
  const chLow = OAuthChallenge.create({ ttlSeconds: 60 });
  const keyLow = 'oauth_ch_' + OAuthChallenge.hashState(chLow.state);
  assert.strictEqual(cacheStore[`${keyLow}_ttl`], 300);

  // Above maximum clamped to 600
  const chHigh = OAuthChallenge.create({ ttlSeconds: 1200 });
  const keyHigh = 'oauth_ch_' + OAuthChallenge.hashState(chHigh.state);
  assert.strictEqual(cacheStore[`${keyHigh}_ttl`], 600);
});

test('OAuthChallenge.consume atomically retrieves and immediately consumes challenge (one-time consumption)', () => {
  const { OAuthChallenge, cacheStore, lockCallLog } = createMockEnvironment();
  const challenge = OAuthChallenge.create();
  const state = challenge.state;
  const stateHash = OAuthChallenge.hashState(state);
  const cacheKey = 'oauth_ch_' + stateHash;

  // First consumption: succeeds
  const consumed = OAuthChallenge.consume(state);
  assert.ok(consumed, 'First consumption must return challenge data');
  assert.strictEqual(consumed.state, state);
  assert.strictEqual(consumed.nonce, challenge.nonce);
  assert.strictEqual(consumed.codeChallenge, challenge.codeChallenge);
  assert.ok(consumed.codeVerifier, 'Must return server-side codeVerifier for subsequent code exchange');

  // Verify record was removed from cache immediately
  assert.strictEqual(cacheStore[cacheKey], undefined, 'Cache record must be removed after consumption');

  // Verify LockService was acquired and released
  assert.ok(lockCallLog.includes('tryLock'));
  assert.ok(lockCallLog.includes('releaseLock'));

  // Second consumption attempt (replay attack): must fail
  const replay = OAuthChallenge.consume(state);
  assert.strictEqual(replay, null, 'Replayed state must return null');
});

test('OAuthChallenge.consume rejects missing, invalid, or malformed state tokens', () => {
  const { OAuthChallenge } = createMockEnvironment();

  assert.strictEqual(OAuthChallenge.consume(''), null);
  assert.strictEqual(OAuthChallenge.consume(null), null);
  assert.strictEqual(OAuthChallenge.consume(undefined), null);
  assert.strictEqual(OAuthChallenge.consume('short'), null, 'Short state rejected');
  assert.strictEqual(OAuthChallenge.consume(12345), null, 'Non-string rejected');
});

test('OAuthChallenge.consume rejects unknown state token', () => {
  const { OAuthChallenge } = createMockEnvironment();
  // Valid format 64 chars, but not in cache
  const unknownState = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  assert.strictEqual(OAuthChallenge.consume(unknownState), null);
});

test('OAuthChallenge.consume rejects expired challenge records', () => {
  const { OAuthChallenge, cacheStore } = createMockEnvironment();
  const state = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const stateHash = OAuthChallenge.hashState(state);
  const cacheKey = 'oauth_ch_' + stateHash;

  // Manually insert an expired challenge record
  cacheStore[cacheKey] = JSON.stringify({
    stateHash: stateHash,
    nonce: 'expired-nonce',
    codeVerifier: 'expired-verifier',
    codeChallenge: 'expired-challenge',
    createdAt: Date.now() - 700000,
    expiresAt: Date.now() - 100000 // In the past
  });

  const consumed = OAuthChallenge.consume(state);
  assert.strictEqual(consumed, null, 'Expired challenge must be rejected');
  assert.strictEqual(cacheStore[cacheKey], undefined, 'Expired record must be removed from cache');
});

test('OAuthChallenge.consume fails closed when LockService cannot acquire lock', () => {
  const { OAuthChallenge } = createMockEnvironment({ lockFail: true });
  // Even with valid state format, lock failure must fail closed
  const state = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const result = OAuthChallenge.consume(state);
  assert.strictEqual(result, null, 'Must fail closed when lock acquisition fails');
});

test('OAuthChallenge.create and consume preserve redirectUri for token exchange integrity', () => {
  const { OAuthChallenge } = createMockEnvironment();
  const testUri = 'https://script.google.com/macros/s/AKfycby123/exec';
  const challenge = OAuthChallenge.create({ redirectUri: testUri });

  const consumed = OAuthChallenge.consume(challenge.state);
  assert.ok(consumed);
  assert.strictEqual(consumed.redirectUri, testUri);
});

test('Concurrent duplicate callbacks cannot both consume the same challenge', () => {
  const { OAuthChallenge, cacheStore } = createMockEnvironment();
  const challenge = OAuthChallenge.create();
  const state = challenge.state;

  // Simulate two concurrent requests arriving with the same state:
  // Request 1 arrives and consumes
  const req1Result = OAuthChallenge.consume(state);
  // Request 2 arrives immediately after
  const req2Result = OAuthChallenge.consume(state);

  assert.ok(req1Result, 'First concurrent request must succeed');
  assert.strictEqual(req2Result, null, 'Second concurrent request must fail');
  assert.strictEqual(cacheStore['oauth_ch_' + OAuthChallenge.hashState(state)], undefined);
});
