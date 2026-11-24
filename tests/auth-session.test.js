/**
 * Unit tests for AuthSession module (src/auth/session.js)
 * Tests application session creation, token entropy, SHA-256 hashing,
 * server-side storage in PropertiesService/CacheService, constant-time validation,
 * absolute lifetime (12h), idle timeout (30m), and rejection of invalid/expired sessions.
 * Executed in GitHub Actions runner via Node.js built-in test runner (node --test).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

function createMockSessionEnvironment(options) {
  const mockProperties = (options && options.properties) || {};
  const cacheStore = (options && options.cache) || {};
  let lockAcquired = false;
  let forceLockFail = options && options.forceLockFail === true;
  let loggedMessages = [];
  let uuidCounter = 1;

  const context = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (mockProperties[key] !== undefined ? mockProperties[key] : null),
        setProperty: (key, val) => { mockProperties[key] = String(val); },
        deleteProperty: (key) => { delete mockProperties[key]; }
      })
    },
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
          if (forceLockFail) return false;
          if (lockAcquired) return false;
          lockAcquired = true;
          return true;
        },
        releaseLock: () => {
          lockAcquired = false;
        }
      })
    },
    Utilities: {
      getUuid: () => {
        const id = String(uuidCounter++).padStart(4, '0');
        return `11111111-2222-4000-8000-${id}${id}${id}`;
      },
      computeDigest: (_algorithm, value, charset) => {
        const encoding = (charset === 'US_ASCII') ? 'ascii' : 'utf8';
        const hash = crypto.createHash('sha256').update(value, encoding).digest();
        return Array.from(hash).map(b => (b > 127 ? b - 256 : b));
      },
      DigestAlgorithm: {
        SHA_256: 'SHA_256'
      },
      Charset: {
        US_ASCII: 'US_ASCII',
        UTF_8: 'UTF_8'
      }
    },
    Logger: {
      log: (msg) => { loggedMessages.push(String(msg)); }
    },
    Date: Date,
    JSON: JSON,
    Math: Math,
    Number: Number,
    String: String,
    isNaN: isNaN,
    Error: Error
  };

  vm.createContext(context);
  const code = fs.readFileSync('src/auth/session.js', 'utf8');
  vm.runInContext(code, context);

  return {
    AuthSession: context.AuthSession,
    mockProperties,
    cacheStore,
    loggedMessages
  };
}

test('AuthSession.generateSessionToken produces high-entropy 96-character hex token', () => {
  const { AuthSession } = createMockSessionEnvironment();
  const token1 = AuthSession.generateSessionToken();
  const token2 = AuthSession.generateSessionToken();

  assert.strictEqual(typeof token1, 'string');
  assert.strictEqual(token1.length, 96);
  assert.match(token1, /^[0-9a-f]{96}$/);

  assert.strictEqual(token2.length, 96);
  assert.notStrictEqual(token1, token2, 'Generated tokens must be distinct');
});

test('AuthSession.hashToken derives consistent SHA-256 hex digest', () => {
  const { AuthSession } = createMockSessionEnvironment();
  const rawToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const expectedHash = crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');

  const hash = AuthSession.hashToken(rawToken);
  assert.strictEqual(hash, expectedHash);
  assert.strictEqual(hash.length, 64);

  // Invalid or empty inputs return empty string
  assert.strictEqual(AuthSession.hashToken(''), '');
  assert.strictEqual(AuthSession.hashToken(null), '');
  assert.strictEqual(AuthSession.hashToken(12345), '');
});

test('AuthSession.constantTimeEquals safely compares equal and unequal strings', () => {
  const { AuthSession } = createMockSessionEnvironment();

  assert.strictEqual(AuthSession.constantTimeEquals('abcd1234', 'abcd1234'), true);
  assert.strictEqual(AuthSession.constantTimeEquals('abcd1234', 'abcd1235'), false);
  assert.strictEqual(AuthSession.constantTimeEquals('abcd1234', 'abcd123'), false);
  assert.strictEqual(AuthSession.constantTimeEquals('abcd1234', null), false);
  assert.strictEqual(AuthSession.constantTimeEquals(null, 'abcd1234'), false);
});

test('AuthSession.createSession successfully creates session for verified identity', () => {
  const { AuthSession, mockProperties, cacheStore } = createMockSessionEnvironment();
  const identity = {
    googleSub: '10987654321',
    email: 'user@example.com',
    emailVerified: true,
    name: 'Verified User'
  };

  const nowBefore = Date.now();
  const result = AuthSession.createSession(identity);
  const nowAfter = Date.now();

  assert.strictEqual(result.success, true);
  assert.ok(result.token, 'Raw session token must be returned upon creation');
  assert.strictEqual(result.token.length, 96);
  assert.ok(result.sessionId, 'Session ID must be returned');
  assert.ok(result.expiresAt >= nowBefore + 43200 * 1000);
  assert.ok(result.expiresAt <= nowAfter + 43200 * 1000);

  // Raw token must NEVER be stored in plaintext server-side
  const tokenHash = AuthSession.hashToken(result.token);
  const storageKey = 'sess_' + tokenHash;

  assert.strictEqual(mockProperties[result.token], undefined);
  assert.strictEqual(cacheStore[result.token], undefined);

  // Storage must contain hashed session record
  assert.ok(mockProperties[storageKey], 'PropertiesService must store record under sess_<tokenHash>');
  const storedRecord = JSON.parse(mockProperties[storageKey]);
  assert.strictEqual(storedRecord.sessionId, result.sessionId);
  assert.strictEqual(storedRecord.tokenHash, tokenHash);
  assert.strictEqual(storedRecord.googleSub, '10987654321');
  assert.strictEqual(storedRecord.email, 'user@example.com');
  assert.strictEqual(storedRecord.status, 'ACTIVE');

  // Cache must also hold the record
  assert.ok(cacheStore[storageKey]);
});

test('AuthSession.createSession rejects unverified or invalid identity', () => {
  const { AuthSession } = createMockSessionEnvironment();

  // Missing emailVerified
  const res1 = AuthSession.createSession({
    googleSub: '123',
    email: 'user@example.com',
    emailVerified: false
  });
  assert.strictEqual(res1.success, false);
  assert.strictEqual(res1.error, 'unverified_identity');

  // Missing email
  const res2 = AuthSession.createSession({
    googleSub: '123',
    emailVerified: true
  });
  assert.strictEqual(res2.success, false);
  assert.strictEqual(res2.error, 'unverified_identity');

  // Missing googleSub
  const res3 = AuthSession.createSession({
    email: 'user@example.com',
    emailVerified: true
  });
  assert.strictEqual(res3.success, false);
  assert.strictEqual(res3.error, 'unverified_identity');

  // Null or missing identity
  assert.strictEqual(AuthSession.createSession(null).success, false);
  assert.strictEqual(AuthSession.createSession('not-an-object').success, false);
});

test('AuthSession.createSession fails closed when lock cannot be acquired', () => {
  const { AuthSession } = createMockSessionEnvironment({ forceLockFail: true });
  const result = AuthSession.createSession({
    googleSub: '123',
    email: 'user@example.com',
    emailVerified: true
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error, 'lock_timeout');
});

test('AuthSession.validateSession validates active session and returns minimal identity', () => {
  const { AuthSession } = createMockSessionEnvironment();
  const createResult = AuthSession.createSession({
    googleSub: '10987654321',
    email: 'user@example.com',
    emailVerified: true,
    name: 'Verified User'
  });

  const validResult = AuthSession.validateSession(createResult.token);
  assert.strictEqual(validResult.valid, true);
  assert.strictEqual(validResult.sessionId, createResult.sessionId);
  assert.strictEqual(validResult.googleSub, '10987654321');
  assert.strictEqual(validResult.email, 'user@example.com');
  assert.strictEqual(validResult.name, 'Verified User');
  assert.strictEqual(validResult.expiresAt, createResult.expiresAt);

  // Sensitive values must NEVER be returned in validation output
  assert.strictEqual(validResult.token, undefined);
  assert.strictEqual(validResult.tokenHash, undefined);
  assert.strictEqual(validResult.sessionToken, undefined);
});

test('AuthSession.validateSession rejects missing, empty, or malformed session tokens', () => {
  const { AuthSession } = createMockSessionEnvironment();

  assert.strictEqual(AuthSession.validateSession('').error, 'missing_session');
  assert.strictEqual(AuthSession.validateSession('   ').error, 'missing_session');
  assert.strictEqual(AuthSession.validateSession(null).error, 'missing_session');
  assert.strictEqual(AuthSession.validateSession(undefined).error, 'missing_session');
  assert.strictEqual(AuthSession.validateSession(12345).error, 'missing_session');

  // Malformed tokens (too short, non-hex, special characters)
  assert.strictEqual(AuthSession.validateSession('short-token').error, 'malformed_session');
  assert.strictEqual(AuthSession.validateSession('z'.repeat(96)).error, 'malformed_session');
  assert.strictEqual(AuthSession.validateSession('!@#$%^&*()').error, 'malformed_session');
});

test('AuthSession.validateSession rejects unknown session token', () => {
  const { AuthSession } = createMockSessionEnvironment();
  const unknownToken = 'a'.repeat(96);
  const result = AuthSession.validateSession(unknownToken);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error, 'invalid_session');
});

test('AuthSession.validateSession rejects expired sessions (absolute timeout)', () => {
  const { AuthSession, mockProperties, cacheStore } = createMockSessionEnvironment();
  const rawToken = 'b'.repeat(96);
  const tokenHash = AuthSession.hashToken(rawToken);
  const now = Date.now();

  const expiredRecord = {
    sessionId: 'sess-expired-1',
    tokenHash: tokenHash,
    googleSub: '123',
    email: 'user@example.com',
    createdAt: now - 50000 * 1000,
    lastSeenAt: now - 100 * 1000,
    expiresAt: now - 1000, // Expired 1 second ago
    status: 'ACTIVE'
  };

  mockProperties['sess_' + tokenHash] = JSON.stringify(expiredRecord);
  cacheStore['sess_' + tokenHash] = JSON.stringify(expiredRecord);

  const result = AuthSession.validateSession(rawToken);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error, 'expired_session');
});

test('AuthSession.validateSession rejects sessions exceeding idle timeout', () => {
  const { AuthSession, mockProperties, cacheStore } = createMockSessionEnvironment();
  const rawToken = 'c'.repeat(96);
  const tokenHash = AuthSession.hashToken(rawToken);
  const now = Date.now();

  const idleRecord = {
    sessionId: 'sess-idle-1',
    tokenHash: tokenHash,
    googleSub: '123',
    email: 'user@example.com',
    createdAt: now - 3600 * 1000,
    lastSeenAt: now - (1801 * 1000), // Inactive for 30m 1s
    expiresAt: now + (10 * 3600 * 1000), // Absolute lifetime still valid
    status: 'ACTIVE'
  };

  mockProperties['sess_' + tokenHash] = JSON.stringify(idleRecord);
  cacheStore['sess_' + tokenHash] = JSON.stringify(idleRecord);

  const result = AuthSession.validateSession(rawToken);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error, 'expired_session');
});

test('AuthSession.validateSession rejects non-ACTIVE status records', () => {
  const { AuthSession, mockProperties } = createMockSessionEnvironment();
  const rawToken = 'd'.repeat(96);
  const tokenHash = AuthSession.hashToken(rawToken);
  const now = Date.now();

  const revokedRecord = {
    sessionId: 'sess-revoked-1',
    tokenHash: tokenHash,
    googleSub: '123',
    email: 'user@example.com',
    createdAt: now - 1000,
    lastSeenAt: now - 500,
    expiresAt: now + 3600 * 1000,
    status: 'REVOKED'
  };

  mockProperties['sess_' + tokenHash] = JSON.stringify(revokedRecord);

  const result = AuthSession.validateSession(rawToken);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error, 'invalid_session');
});

test('AuthSession.validateSession falls back to PropertiesService on cache miss', () => {
  const { AuthSession, mockProperties, cacheStore } = createMockSessionEnvironment();
  const createResult = AuthSession.createSession({
    googleSub: 'sub-persistent-1',
    email: 'persistent@example.com',
    emailVerified: true
  });

  // Clear cacheStore to simulate cache eviction
  const tokenHash = AuthSession.hashToken(createResult.token);
  delete cacheStore['sess_' + tokenHash];

  // Validation must still succeed using persistent PropertiesService
  const validateResult = AuthSession.validateSession(createResult.token);
  assert.strictEqual(validateResult.valid, true);
  assert.strictEqual(validateResult.email, 'persistent@example.com');
});
