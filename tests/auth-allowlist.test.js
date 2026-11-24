/**
 * Unit tests for AuthAllowlist module (src/auth/allowlist.js)
 * Covers account allowlist authorization, case-insensitive email matching,
 * Google sub matching, fail-closed handling, and rejection of unauthorized identities.
 * Executed in GitHub Actions runner via Node.js built-in test runner (node --test).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');

function createMockAllowlistEnvironment(mockProperties, mockLogger) {
  let loggedMessages = [];
  const context = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (mockProperties && mockProperties[key] !== undefined ? mockProperties[key] : null)
      })
    },
    Logger: mockLogger || {
      log: (msg) => { loggedMessages.push(String(msg)); }
    },
    String: String,
    Error: Error
  };

  vm.createContext(context);
  const code = fs.readFileSync('src/auth/allowlist.js', 'utf8');
  vm.runInContext(code, context);

  return {
    AuthAllowlist: context.AuthAllowlist,
    loggedMessages
  };
}

test('AuthAllowlist.authorize permits allowlisted email with verified status', () => {
  const { AuthAllowlist } = createMockAllowlistEnvironment({
    ALLOWED_EMAILS: 'owner@gmail.com, partner@gmail.com'
  });

  const identity = {
    googleSub: '10987654321',
    email: 'owner@gmail.com',
    emailVerified: true
  };

  const result = AuthAllowlist.authorize(identity);
  assert.strictEqual(result.authorized, true);
  assert.strictEqual(result.errorCode, undefined);
});

test('AuthAllowlist.authorize handles case-insensitive email and whitespace normalization', () => {
  const { AuthAllowlist } = createMockAllowlistEnvironment({
    ALLOWED_EMAILS: '  Owner.Family@Gmail.com ,  PARTNER@gmail.com  '
  });

  // Test lowercase input matching mixed-case configuration
  const result1 = AuthAllowlist.authorize({
    googleSub: '123',
    email: 'owner.family@gmail.com',
    emailVerified: true
  });
  assert.strictEqual(result1.authorized, true);

  // Test mixed-case input with surrounding whitespace matching lowercase configuration
  const result2 = AuthAllowlist.authorize({
    googleSub: '456',
    email: '   Partner@Gmail.COM   ',
    emailVerified: true
  });
  assert.strictEqual(result2.authorized, true);
});

test('AuthAllowlist.authorize supports Google sub matching via ALLOWED_GOOGLE_SUBS', () => {
  const { AuthAllowlist } = createMockAllowlistEnvironment({
    ALLOWED_GOOGLE_SUBS: '109876543210987654321, 209876543210987654321'
  });

  const resultAuthorized = AuthAllowlist.authorize({
    googleSub: '109876543210987654321',
    email: 'unknown-email@example.com',
    emailVerified: true
  });
  assert.strictEqual(resultAuthorized.authorized, true);

  const resultDenied = AuthAllowlist.authorize({
    googleSub: '999999999999999999999',
    email: 'unknown-email@example.com',
    emailVerified: true
  });
  assert.strictEqual(resultDenied.authorized, false);
  assert.strictEqual(resultDenied.errorCode, 'unauthorized_account');
});

test('AuthAllowlist.authorize parses semicolon, newline, and comma delimited configuration', () => {
  const { AuthAllowlist } = createMockAllowlistEnvironment({
    ALLOWED_EMAILS: "user1@example.com; user2@example.com\nuser3@example.com"
  });

  assert.strictEqual(AuthAllowlist.authorize({ email: 'user1@example.com', emailVerified: true }).authorized, true);
  assert.strictEqual(AuthAllowlist.authorize({ email: 'user2@example.com', emailVerified: true }).authorized, true);
  assert.strictEqual(AuthAllowlist.authorize({ email: 'user3@example.com', emailVerified: true }).authorized, true);
  assert.strictEqual(AuthAllowlist.authorize({ email: 'user4@example.com', emailVerified: true }).authorized, false);
});

test('AuthAllowlist.authorize supports property aliases AUTHORIZED_EMAILS and ALLOWLIST_EMAILS', () => {
  const { AuthAllowlist: authAlias1 } = createMockAllowlistEnvironment({
    AUTHORIZED_EMAILS: 'alias1@gmail.com'
  });
  assert.strictEqual(authAlias1.authorize({ email: 'alias1@gmail.com', emailVerified: true }).authorized, true);

  const { AuthAllowlist: authAlias2 } = createMockAllowlistEnvironment({
    ALLOWLIST_EMAILS: 'alias2@gmail.com'
  });
  assert.strictEqual(authAlias2.authorize({ email: 'alias2@gmail.com', emailVerified: true }).authorized, true);
});

test('AuthAllowlist.authorize denies identity not present in allowlist', () => {
  const { AuthAllowlist } = createMockAllowlistEnvironment({
    ALLOWED_EMAILS: 'owner@gmail.com, partner@gmail.com'
  });

  const result = AuthAllowlist.authorize({
    googleSub: '99999',
    email: 'intruder@gmail.com',
    emailVerified: true
  });

  assert.strictEqual(result.authorized, false);
  assert.strictEqual(result.errorCode, 'unauthorized_account');
  assert.strictEqual(result.errorMessage, 'This Google account is not authorized to access the application.');
});

test('AuthAllowlist.authorize fails closed when allowlist configuration is empty or whitespace', () => {
  const { AuthAllowlist: authEmpty } = createMockAllowlistEnvironment({
    ALLOWED_EMAILS: '   '
  });

  const result = authEmpty.authorize({
    googleSub: '123',
    email: 'user@gmail.com',
    emailVerified: true
  });

  assert.strictEqual(result.authorized, false);
  assert.strictEqual(result.errorCode, 'allowlist_unconfigured');
  assert.strictEqual(result.errorMessage, 'This Google account is not authorized to access the application.');
});

test('AuthAllowlist.authorize fails closed when allowlist configuration is malformed', () => {
  // Test invalid string without any '@' symbols
  const { AuthAllowlist: authMalformed1 } = createMockAllowlistEnvironment({
    ALLOWED_EMAILS: 'notanemail, alsoinvalid'
  });

  const result1 = authMalformed1.authorize({
    googleSub: '123',
    email: 'user@gmail.com',
    emailVerified: true
  });
  assert.strictEqual(result1.authorized, false);
  assert.strictEqual(result1.errorCode, 'allowlist_unconfigured');

  // Test non-string configuration
  const { AuthAllowlist: authMalformed2 } = createMockAllowlistEnvironment({
    ALLOWED_EMAILS: 12345
  });
  const result2 = authMalformed2.authorize({
    googleSub: '123',
    email: 'user@gmail.com',
    emailVerified: true
  });
  assert.strictEqual(result2.authorized, false);
  assert.strictEqual(result2.errorCode, 'allowlist_unconfigured');
});

test('AuthAllowlist.authorize fails closed when Script Properties has no allowlist keys', () => {
  const { AuthAllowlist } = createMockAllowlistEnvironment({});

  const result = AuthAllowlist.authorize({
    googleSub: '123',
    email: 'user@gmail.com',
    emailVerified: true
  });

  assert.strictEqual(result.authorized, false);
  assert.strictEqual(result.errorCode, 'allowlist_unconfigured');
});

test('AuthAllowlist.authorize denies missing or invalid identity object', () => {
  const { AuthAllowlist } = createMockAllowlistEnvironment({
    ALLOWED_EMAILS: 'user@gmail.com'
  });

  assert.strictEqual(AuthAllowlist.authorize(null).authorized, false);
  assert.strictEqual(AuthAllowlist.authorize(undefined).authorized, false);
  assert.strictEqual(AuthAllowlist.authorize('not-an-object').authorized, false);
  assert.strictEqual(AuthAllowlist.authorize(null).errorMessage, 'This Google account is not authorized to access the application.');
});

test('AuthAllowlist.authorize denies missing or invalid email when email matching is configured', () => {
  const { AuthAllowlist } = createMockAllowlistEnvironment({
    ALLOWED_EMAILS: 'owner@gmail.com'
  });

  // Missing email
  const resMissing = AuthAllowlist.authorize({
    googleSub: '123',
    emailVerified: true
  });
  assert.strictEqual(resMissing.authorized, false);
  assert.strictEqual(resMissing.errorCode, 'missing_email');

  // Invalid email format in identity
  const resInvalid = AuthAllowlist.authorize({
    googleSub: '123',
    email: 'notanemail',
    emailVerified: true
  });
  assert.strictEqual(resInvalid.authorized, false);
  assert.strictEqual(resInvalid.errorCode, 'missing_email');
});

test('AuthAllowlist.authorize denies missing googleSub when Google sub matching is configured', () => {
  const { AuthAllowlist } = createMockAllowlistEnvironment({
    ALLOWED_GOOGLE_SUBS: '109876543210987654321'
  });

  const res = AuthAllowlist.authorize({
    email: 'user@example.com',
    emailVerified: true
  });
  assert.strictEqual(res.authorized, false);
  assert.strictEqual(res.errorCode, 'missing_google_sub');
});

test('AuthAllowlist.authorize denies unverified email (emailVerified !== true)', () => {
  const { AuthAllowlist } = createMockAllowlistEnvironment({
    ALLOWED_EMAILS: 'owner@gmail.com'
  });

  const result = AuthAllowlist.authorize({
    googleSub: '123',
    email: 'owner@gmail.com',
    emailVerified: false // Unverified
  });

  assert.strictEqual(result.authorized, false);
  assert.strictEqual(result.errorCode, 'unverified_email');
});

test('AuthAllowlist.authorize rejects substring, prefix, suffix, and domain spoofing attacks', () => {
  const { AuthAllowlist } = createMockAllowlistEnvironment({
    ALLOWED_EMAILS: 'user@example.com'
  });

  // Suffix extension attack
  assert.strictEqual(AuthAllowlist.authorize({ email: 'user@example.com.evil.com', emailVerified: true }).authorized, false);
  // Prefix attack
  assert.strictEqual(AuthAllowlist.authorize({ email: 'attackeruser@example.com', emailVerified: true }).authorized, false);
  // Domain-only check (arbitrary user at same domain)
  assert.strictEqual(AuthAllowlist.authorize({ email: 'other@example.com', emailVerified: true }).authorized, false);
  // Subdomain injection
  assert.strictEqual(AuthAllowlist.authorize({ email: 'user@sub.example.com', emailVerified: true }).authorized, false);
});

test('AuthAllowlist.authorize rejects email alias unless explicitly configured', () => {
  const { AuthAllowlist } = createMockAllowlistEnvironment({
    ALLOWED_EMAILS: 'user@gmail.com'
  });

  // Alias with +tag must not match unless explicitly listed
  const result = AuthAllowlist.authorize({
    email: 'user+secret@gmail.com',
    emailVerified: true
  });
  assert.strictEqual(result.authorized, false);
  assert.strictEqual(result.errorCode, 'unauthorized_account');
});

test('AuthAllowlist.authorize output contains only safe decision fields and no sensitive leaks', () => {
  const { AuthAllowlist, loggedMessages } = createMockAllowlistEnvironment({
    ALLOWED_EMAILS: 'secret-owner@gmail.com'
  });

  // Test unauthorized output
  const resDenied = AuthAllowlist.authorize({
    email: 'intruder@evil.com',
    emailVerified: true
  });
  assert.strictEqual(resDenied.authorized, false);
  assert.strictEqual(resDenied.errorCode, 'unauthorized_account');
  assert.strictEqual(resDenied.errorMessage, 'This Google account is not authorized to access the application.');
  // Ensure allowlist was NOT leaked in errorMessage
  assert.ok(!resDenied.errorMessage.includes('secret-owner'));

  // Ensure logs do NOT leak email addresses or tokens
  const allLogs = loggedMessages.join(' ');
  assert.ok(!allLogs.includes('secret-owner@gmail.com'));
  assert.ok(!allLogs.includes('intruder@evil.com'));
});
