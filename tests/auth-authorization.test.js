/**
 * Unit tests for AuthAuthorization module (src/auth/authorization.js) and webapp endpoints (FFM-012)
 * Covers server-side household membership resolution, OWNER/PARTNER role-based access control (RBAC),
 * household data isolation, session integration, and configuration fail-closed behavior.
 * Executed in GitHub Actions runner via Node.js built-in test runner (node --test).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

function createAuthorizationEnvironment(options) {
  const defaultProps = {
    HOUSEHOLD_ID: 'hh-family-001',
    HOUSEHOLD_NAME: 'Utama Family Household',
    HOUSEHOLD_STATUS: 'ACTIVE',
    DB_SPREADSHEET_ID: '1SecretPrivateSpreadsheetIdDoNotExpose999',
    ALLOWED_EMAILS: 'owner@example.com, partner@example.com, outsider-allowlisted@example.com',
    HOUSEHOLD_MEMBERS_JSON: JSON.stringify([
      {
        membership_id: 'mem-owner-01',
        user_id: 'usr-owner-01',
        household_id: 'hh-family-001',
        google_sub: '100000000000000000001',
        email: 'owner@example.com',
        role: 'OWNER',
        status: 'ACTIVE',
        user_status: 'ACTIVE'
      },
      {
        membership_id: 'mem-partner-02',
        user_id: 'usr-partner-02',
        household_id: 'hh-family-001',
        google_sub: '100000000000000000002',
        email: 'partner@example.com',
        role: 'PARTNER',
        status: 'ACTIVE',
        user_status: 'ACTIVE'
      }
    ])
  };

  const mockProperties = (options && options.properties !== undefined)
    ? options.properties
    : defaultProps;
  const cacheStore = (options && options.cache) || {};
  let lockAcquired = false;
  let uuidCounter = 1;
  const loggedMessages = [];

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
        return `22222222-3333-4000-8000-${id}${id}${id}`;
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
    HtmlService: {
      createTemplateFromFile: () => ({
        evaluate: () => ({
          setTitle: () => {},
          addMetaTag: () => {},
          setXFrameOptionsMode: () => {}
        })
      }),
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' }
    },
    Logger: {
      log: (msg) => { loggedMessages.push(String(msg)); }
    },
    Date: Date,
    JSON: JSON,
    Math: Math,
    Number: Number,
    String: String,
    Object: Object,
    Array: Array,
    isNaN: isNaN,
    Error: Error
  };

  vm.createContext(context);
  vm.runInContext(fs.readFileSync('src/auth/allowlist.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/auth/session.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/auth/authorization.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/ui/webapp.js', 'utf8'), context);

  return {
    AuthAllowlist: context.AuthAllowlist,
    AuthSession: context.AuthSession,
    AuthAuthorization: context.AuthAuthorization,
    apiGetHouseholdContext: context.apiGetHouseholdContext,
    apiAuthorizeOperation: context.apiAuthorizeOperation,
    apiLogout: context.apiLogout,
    mockProperties,
    cacheStore,
    loggedMessages
  };
}

// ============================================================================
// 1. Membership Resolution Tests
// ============================================================================

test('AuthAuthorization resolves valid OWNER and PARTNER memberships from server-side session', () => {
  const { AuthSession, AuthAuthorization } = createAuthorizationEnvironment();

  const ownerSession = AuthSession.createSession({
    googleSub: '100000000000000000001',
    email: 'owner@example.com',
    emailVerified: true,
    name: 'Household Owner'
  });
  const partnerSession = AuthSession.createSession({
    googleSub: '100000000000000000002',
    email: 'partner@example.com',
    emailVerified: true,
    name: 'Household Partner'
  });

  const ownerAuth = AuthAuthorization.authorizeRequest(ownerSession.token, 'household.view');
  assert.strictEqual(ownerAuth.authorized, true);
  assert.strictEqual(ownerAuth.authenticated, true);
  assert.strictEqual(ownerAuth.context.role, 'OWNER');
  assert.strictEqual(ownerAuth.context.actor.userId, 'usr-owner-01');
  assert.strictEqual(ownerAuth.context.actor.membershipId, 'mem-owner-01');
  assert.strictEqual(ownerAuth.context.actor.googleSub, '100000000000000000001');
  assert.strictEqual(ownerAuth.context.actor.email, 'owner@example.com');
  assert.strictEqual(ownerAuth.context.household.householdId, 'hh-family-001');
  assert.strictEqual(ownerAuth.context.household.baseCurrency, 'IDR');
  assert.strictEqual(ownerAuth.context.household.timezone, 'Asia/Jakarta');

  const partnerAuth = AuthAuthorization.authorizeRequest(partnerSession.token, 'household.view');
  assert.strictEqual(partnerAuth.authorized, true);
  assert.strictEqual(partnerAuth.authenticated, true);
  assert.strictEqual(partnerAuth.context.role, 'PARTNER');
  assert.strictEqual(partnerAuth.context.actor.userId, 'usr-partner-02');
  assert.strictEqual(partnerAuth.context.actor.membershipId, 'mem-partner-02');
  assert.strictEqual(partnerAuth.context.household.householdId, 'hh-family-001');
});

test('AuthAuthorization supports flat Script Properties configuration for OWNER and PARTNER', () => {
  const { AuthSession, AuthAuthorization } = createAuthorizationEnvironment({
    properties: {
      HOUSEHOLD_ID: 'hh-flat-001',
      HOUSEHOLD_NAME: 'Flat Config Household',
      OWNER_EMAIL: 'owner@example.com',
      OWNER_GOOGLE_SUB: 'sub-owner-flat',
      PARTNER_EMAIL: 'partner@example.com',
      PARTNER_GOOGLE_SUB: 'sub-partner-flat'
    }
  });

  const ownerSession = AuthSession.createSession({
    googleSub: 'sub-owner-flat',
    email: 'owner@example.com',
    emailVerified: true
  });
  const partnerSession = AuthSession.createSession({
    googleSub: 'sub-partner-flat',
    email: 'partner@example.com',
    emailVerified: true
  });

  const ownerRes = AuthAuthorization.authorizeRequest(ownerSession.token, 'household.view');
  assert.strictEqual(ownerRes.authorized, true);
  assert.strictEqual(ownerRes.context.role, 'OWNER');
  assert.strictEqual(ownerRes.context.household.householdId, 'hh-flat-001');

  const partnerRes = AuthAuthorization.authorizeRequest(partnerSession.token, 'household.view');
  assert.strictEqual(partnerRes.authorized, true);
  assert.strictEqual(partnerRes.context.role, 'PARTNER');
  assert.strictEqual(partnerRes.context.household.householdId, 'hh-flat-001');
});

test('AuthAuthorization denies allowlisted user who has no household membership', () => {
  const { AuthAllowlist, AuthSession, AuthAuthorization } = createAuthorizationEnvironment();

  const outsiderIdentity = {
    googleSub: '100000000000000000999',
    email: 'outsider-allowlisted@example.com',
    emailVerified: true,
    name: 'Allowlisted Non-Member'
  };

  // FFM-009 allowlist authorization succeeds
  const allowRes = AuthAllowlist.authorize(outsiderIdentity);
  assert.strictEqual(allowRes.authorized, true);

  // FFM-010 session creation succeeds
  const sessionRes = AuthSession.createSession(outsiderIdentity);
  assert.strictEqual(sessionRes.success, true);

  // FFM-012 household authorization denies access with membership_not_found
  const authzRes = AuthAuthorization.authorizeRequest(sessionRes.token, 'household.view');
  assert.strictEqual(authzRes.authorized, false);
  assert.strictEqual(authzRes.authenticated, true);
  assert.strictEqual(authzRes.errorCode, 'membership_not_found');
  assert.strictEqual(authzRes.errorMessage, 'You are not authorized to perform this operation.');
  assert.strictEqual(authzRes.context, undefined);
});

test('AuthAuthorization denies inactive or suspended memberships and disabled users', () => {
  const statuses = ['INVITED', 'SUSPENDED', 'LEFT', 'INACTIVE', 'REVOKED'];

  for (let i = 0; i < statuses.length; i++) {
    const status = statuses[i];
    const { AuthSession, AuthAuthorization } = createAuthorizationEnvironment({
      properties: {
        HOUSEHOLD_ID: 'hh-family-001',
        HOUSEHOLD_MEMBERS_JSON: JSON.stringify([
          {
            user_id: 'usr-1',
            google_sub: 'sub-inactive-1',
            email: 'inactive@example.com',
            role: 'PARTNER',
            status: status
          }
        ])
      }
    });

    const session = AuthSession.createSession({
      googleSub: 'sub-inactive-1',
      email: 'inactive@example.com',
      emailVerified: true
    });

    const res = AuthAuthorization.authorizeRequest(session.token, 'household.view');
    assert.strictEqual(res.authorized, false, `Status ${status} must be denied`);
    assert.strictEqual(res.errorCode, 'membership_inactive');
  }

  // Also test user_status === 'DISABLED' even when membership status === 'ACTIVE'
  const { AuthSession: sess2, AuthAuthorization: authz2 } = createAuthorizationEnvironment({
    properties: {
      HOUSEHOLD_ID: 'hh-family-001',
      HOUSEHOLD_MEMBERS_JSON: JSON.stringify([
        {
          user_id: 'usr-disabled',
          google_sub: 'sub-disabled',
          email: 'disabled@example.com',
          role: 'OWNER',
          status: 'ACTIVE',
          user_status: 'DISABLED'
        }
      ])
    }
  });
  const disabledSession = sess2.createSession({
    googleSub: 'sub-disabled',
    email: 'disabled@example.com',
    emailVerified: true
  });
  const disabledRes = authz2.authorizeRequest(disabledSession.token, 'household.view');
  assert.strictEqual(disabledRes.authorized, false);
  assert.strictEqual(disabledRes.errorCode, 'membership_inactive');
});

test('AuthAuthorization denies member when household reference is missing or household is inactive', () => {
  // Case 1: Member record has empty household_id
  const env1 = createAuthorizationEnvironment({
    properties: {
      HOUSEHOLD_ID: 'hh-family-001',
      HOUSEHOLD_MEMBERS_JSON: JSON.stringify([
        {
          user_id: 'usr-1',
          google_sub: 'sub-1',
          email: 'owner@example.com',
          household_id: '',
          role: 'OWNER',
          status: 'ACTIVE'
        }
      ])
    }
  });
  const s1 = env1.AuthSession.createSession({
    googleSub: 'sub-1',
    email: 'owner@example.com',
    emailVerified: true
  });
  const r1 = env1.AuthAuthorization.authorizeRequest(s1.token, 'household.view');
  assert.strictEqual(r1.authorized, false);
  assert.strictEqual(r1.errorCode, 'household_not_found');

  // Case 2: Household status is INACTIVE
  const env2 = createAuthorizationEnvironment({
    properties: {
      HOUSEHOLD_ID: 'hh-family-001',
      HOUSEHOLD_STATUS: 'INACTIVE',
      OWNER_EMAIL: 'owner@example.com'
    }
  });
  const s2 = env2.AuthSession.createSession({
    googleSub: 'sub-1',
    email: 'owner@example.com',
    emailVerified: true
  });
  const r2 = env2.AuthAuthorization.authorizeRequest(s2.token, 'household.view');
  assert.strictEqual(r2.authorized, false);
  assert.strictEqual(r2.errorCode, 'household_not_found');
});

test('AuthAuthorization prevents browser-submitted identity from overriding server session identity', () => {
  const { AuthSession, AuthAuthorization } = createAuthorizationEnvironment();

  // Create session for allowlisted non-member
  const nonMemberSession = AuthSession.createSession({
    googleSub: '100000000000000000999',
    email: 'outsider-allowlisted@example.com',
    emailVerified: true
  });

  // Attempt to forge OWNER identity in requestScope
  const forgedPayload = {
    userId: 'usr-owner-01',
    user_id: 'usr-owner-01',
    googleSub: '100000000000000000001',
    google_sub: '100000000000000000001',
    email: 'owner@example.com',
    role: 'OWNER',
    isOwner: true,
    isAdmin: true
  };

  const result = AuthAuthorization.authorizeRequest(nonMemberSession.token, 'household.view', forgedPayload);
  assert.strictEqual(result.authorized, false);
  assert.strictEqual(result.errorCode, 'membership_not_found');
});

test('AuthAuthorization requires googleSub match when googleSub is configured on member record', () => {
  const { AuthSession, AuthAuthorization } = createAuthorizationEnvironment();

  // Session has owner's email, but a different googleSub
  const spoofedSubSession = AuthSession.createSession({
    googleSub: '999999999999999999999',
    email: 'owner@example.com',
    emailVerified: true
  });

  const result = AuthAuthorization.authorizeRequest(spoofedSubSession.token, 'household.view');
  assert.strictEqual(result.authorized, false);
  assert.strictEqual(result.errorCode, 'membership_not_found');
});

// ============================================================================
// 2. Role-Based Access Control (RBAC) Tests
// ============================================================================

test('AuthAuthorization grants OWNER both shared finance and owner-only administrative permissions', () => {
  const { AuthSession, AuthAuthorization } = createAuthorizationEnvironment();
  const ownerSession = AuthSession.createSession({
    googleSub: '100000000000000000001',
    email: 'owner@example.com',
    emailVerified: true
  });

  const permissionsToTest = [
    'household.view',
    'dashboard.view',
    'account.create',
    'transaction.create',
    'transaction.post',
    'transaction.void',
    'budget.create',
    'bill.pay',
    'savings.contribute',
    'liability.pay',
    'asset.valuate',
    'investment.trade',
    'report.export',
    'household.settings.manage',
    'household.member.manage',
    'security.settings.manage',
    'session.revoke_any',
    'system.backup.manage',
    'audit.view'
  ];

  for (let i = 0; i < permissionsToTest.length; i++) {
    const perm = permissionsToTest[i];
    const res = AuthAuthorization.authorizeRequest(ownerSession.token, perm);
    assert.strictEqual(res.authorized, true, `OWNER must be permitted ${perm}`);
  }
});

test('AuthAuthorization grants PARTNER shared finance permissions and denies owner-only permissions', () => {
  const { AuthSession, AuthAuthorization } = createAuthorizationEnvironment();
  const partnerSession = AuthSession.createSession({
    googleSub: '100000000000000000002',
    email: 'partner@example.com',
    emailVerified: true
  });

  const permittedForPartner = [
    'household.view',
    'dashboard.view',
    'account.view',
    'account.create',
    'category.create',
    'transaction.view',
    'transaction.create',
    'transaction.post',
    'transaction.void',
    'budget.view',
    'budget.create',
    'bill.view',
    'bill.pay',
    'savings.view',
    'liability.view',
    'asset.view',
    'investment.view',
    'attachment.upload',
    'report.view',
    'report.export',
    'session.revoke_own'
  ];

  for (let i = 0; i < permittedForPartner.length; i++) {
    const perm = permittedForPartner[i];
    const res = AuthAuthorization.authorizeRequest(partnerSession.token, perm);
    assert.strictEqual(res.authorized, true, `PARTNER must be permitted ${perm}`);
  }

  const deniedForPartner = [
    'household.settings.manage',
    'household.member.manage',
    'security.settings.manage',
    'session.revoke_any',
    'system.backup.manage',
    'audit.view'
  ];

  for (let j = 0; j < deniedForPartner.length; j++) {
    const deniedPerm = deniedForPartner[j];
    const res = AuthAuthorization.authorizeRequest(partnerSession.token, deniedPerm);
    assert.strictEqual(res.authorized, false, `PARTNER must be denied ${deniedPerm}`);
    assert.strictEqual(res.errorCode, 'permission_denied');
    assert.strictEqual(res.errorMessage, 'You are not authorized to perform this operation.');
  }
});

test('AuthAuthorization denies unknown, empty, or unlisted permissions by default for all roles', () => {
  const { AuthSession, AuthAuthorization } = createAuthorizationEnvironment();
  const ownerSession = AuthSession.createSession({
    googleSub: '100000000000000000001',
    email: 'owner@example.com',
    emailVerified: true
  });

  const invalidPermissions = [
    'transaction.physical_delete',
    'database.drop',
    'admin.superuser',
    '',
    '   ',
    null
  ];

  for (let i = 0; i < invalidPermissions.length; i++) {
    const perm = invalidPermissions[i];
    const res = AuthAuthorization.authorizeRequest(ownerSession.token, perm);
    assert.strictEqual(res.authorized, false, `Invalid permission "${perm}" must be denied`);
    assert.strictEqual(res.errorCode, 'permission_denied');
  }
});

test('AuthAuthorization denies missing or unknown roles (fail closed, no fallback role)', () => {
  const badRoles = ['', null, 'ADMIN', 'ADMINISTRATOR', 'MEMBER', 'GUEST', 'USER', 'owner', 'partner'];

  for (let i = 0; i < badRoles.length; i++) {
    const badRole = badRoles[i];
    const { AuthSession, AuthAuthorization } = createAuthorizationEnvironment({
      properties: {
        HOUSEHOLD_ID: 'hh-family-001',
        HOUSEHOLD_MEMBERS_JSON: JSON.stringify([
          {
            user_id: 'usr-bad-role',
            google_sub: 'sub-bad-role',
            email: 'badrole@example.com',
            role: badRole,
            status: 'ACTIVE'
          }
        ])
      }
    });

    const session = AuthSession.createSession({
      googleSub: 'sub-bad-role',
      email: 'badrole@example.com',
      emailVerified: true
    });

    const res = AuthAuthorization.authorizeRequest(session.token, 'household.view');
    assert.strictEqual(res.authorized, false, `Role "${badRole}" must be rejected`);
    assert.strictEqual(res.errorCode, 'role_not_found');
  }
});

test('AuthAuthorization prevents PARTNER from escalating role via browser payload flags', () => {
  const { AuthSession, AuthAuthorization } = createAuthorizationEnvironment();
  const partnerSession = AuthSession.createSession({
    googleSub: '100000000000000000002',
    email: 'partner@example.com',
    emailVerified: true
  });

  const escalationAttempt = {
    role: 'OWNER',
    isOwner: true,
    isAdmin: true,
    permissions: ['household.member.manage', 'security.settings.manage'],
    context: {
      role: 'OWNER',
      authorized: true
    }
  };

  const res = AuthAuthorization.authorizeRequest(
    partnerSession.token,
    'household.member.manage',
    escalationAttempt
  );

  assert.strictEqual(res.authorized, false);
  assert.strictEqual(res.errorCode, 'permission_denied');
});

// ============================================================================
// 3. Household Data Isolation Tests
// ============================================================================

test('AuthAuthorization allows requests matching authorized household and rejects cross-household requests', () => {
  const { AuthSession, AuthAuthorization } = createAuthorizationEnvironment();
  const ownerSession = AuthSession.createSession({
    googleSub: '100000000000000000001',
    email: 'owner@example.com',
    emailVerified: true
  });

  // Matching household ID succeeds
  const validRes = AuthAuthorization.authorizeRequest(ownerSession.token, 'transaction.view', {
    householdId: 'hh-family-001'
  });
  assert.strictEqual(validRes.authorized, true);
  assert.strictEqual(validRes.context.household.householdId, 'hh-family-001');

  // Forged foreign householdId is rejected
  const foreignRes1 = AuthAuthorization.authorizeRequest(ownerSession.token, 'transaction.view', {
    householdId: 'hh-other-family-999'
  });
  assert.strictEqual(foreignRes1.authorized, false);
  assert.strictEqual(foreignRes1.errorCode, 'household_access_denied');

  // Forged snake_case household_id is rejected
  const foreignRes2 = AuthAuthorization.authorizeRequest(ownerSession.token, 'transaction.view', {
    household_id: 'hh-other-family-999'
  });
  assert.strictEqual(foreignRes2.authorized, false);
  assert.strictEqual(foreignRes2.errorCode, 'household_access_denied');

  // Malformed householdId in request is rejected
  const malformedRes = AuthAuthorization.authorizeRequest(ownerSession.token, 'transaction.view', {
    householdId: 'hh-family-001; DROP TABLE'
  });
  assert.strictEqual(malformedRes.authorized, false);
  assert.strictEqual(malformedRes.errorCode, 'household_access_denied');
});

test('AuthAuthorization rejects any browser-supplied spreadsheet ID or Drive folder ID', () => {
  const { AuthSession, AuthAuthorization } = createAuthorizationEnvironment();
  const ownerSession = AuthSession.createSession({
    googleSub: '100000000000000000001',
    email: 'owner@example.com',
    emailVerified: true
  });

  const forbiddenPayloads = [
    { spreadsheetId: '1ForgedSpreadsheetId' },
    { spreadsheet_id: '1ForgedSpreadsheetId' },
    { dbSpreadsheetId: '1ForgedSpreadsheetId' },
    { driveFolderId: '1ForgedDriveFolderId' },
    { attachmentsFolderId: '1ForgedAttachmentsFolderId' },
    // Even passing the actual server spreadsheet ID from the browser must be rejected
    { spreadsheetId: '1SecretPrivateSpreadsheetIdDoNotExpose999' }
  ];

  for (let i = 0; i < forbiddenPayloads.length; i++) {
    const res = AuthAuthorization.authorizeRequest(
      ownerSession.token,
      'transaction.view',
      forbiddenPayloads[i]
    );
    assert.strictEqual(res.authorized, false);
    assert.strictEqual(res.errorCode, 'household_access_denied');
  }
});

test('AuthAuthorization rejects cross-household resource access', () => {
  const { AuthSession, AuthAuthorization } = createAuthorizationEnvironment();
  const partnerSession = AuthSession.createSession({
    googleSub: '100000000000000000002',
    email: 'partner@example.com',
    emailVerified: true
  });

  // Resource belonging to another household via resourceHouseholdId
  const res1 = AuthAuthorization.authorizeRequest(partnerSession.token, 'account.update', {
    accountId: 'acc-123',
    resourceHouseholdId: 'hh-foreign-777'
  });
  assert.strictEqual(res1.authorized, false);
  assert.strictEqual(res1.errorCode, 'household_access_denied');

  // Resource object belonging to another household
  const res2 = AuthAuthorization.authorizeRequest(partnerSession.token, 'transaction.view', {
    resource: {
      transactionId: 'tx-999',
      household_id: 'hh-foreign-777'
    }
  });
  assert.strictEqual(res2.authorized, false);
  assert.strictEqual(res2.errorCode, 'household_access_denied');

  // Resource object belonging to the authorized household succeeds
  const res3 = AuthAuthorization.authorizeRequest(partnerSession.token, 'transaction.view', {
    resource: {
      transactionId: 'tx-100',
      household_id: 'hh-family-001'
    }
  });
  assert.strictEqual(res3.authorized, true);
});

test('AuthAuthorization.authorizeAndExecute never executes operation callback when authorization fails', () => {
  const { AuthSession, AuthAuthorization } = createAuthorizationEnvironment();
  const partnerSession = AuthSession.createSession({
    googleSub: '100000000000000000002',
    email: 'partner@example.com',
    emailVerified: true
  });

  let callbackExecuted = false;
  const deniedResult = AuthAuthorization.authorizeAndExecute(
    partnerSession.token,
    'household.member.manage',
    {},
    () => {
      callbackExecuted = true;
      return { mutated: true };
    }
  );

  assert.strictEqual(callbackExecuted, false, 'Protected operation must never run when unauthorized');
  assert.strictEqual(deniedResult.success, false);
  assert.strictEqual(deniedResult.authorized, false);
  assert.strictEqual(deniedResult.errorCode, 'permission_denied');

  // Now verify callback executes when authorized and receives frozen context
  const permittedResult = AuthAuthorization.authorizeAndExecute(
    partnerSession.token,
    'transaction.create',
    { householdId: 'hh-family-001' },
    (ctx) => {
      callbackExecuted = true;
      assert.strictEqual(Object.isFrozen(ctx), true);
      assert.strictEqual(Object.isFrozen(ctx.actor), true);
      assert.strictEqual(Object.isFrozen(ctx.household), true);
      assert.strictEqual(Object.isFrozen(ctx.permissions), true);
      return { createdInHousehold: ctx.household.householdId, byRole: ctx.role };
    }
  );

  assert.strictEqual(callbackExecuted, true);
  assert.strictEqual(permittedResult.success, true);
  assert.strictEqual(permittedResult.authorized, true);
  assert.strictEqual(permittedResult.data.createdInHousehold, 'hh-family-001');
  assert.strictEqual(permittedResult.data.byRole, 'PARTNER');
});

// ============================================================================
// 4. Authentication & Session Lifecycle Regression Tests
// ============================================================================

test('AuthAuthorization rejects missing, malformed, unknown, expired, and revoked sessions', () => {
  const { AuthSession, AuthAuthorization, mockProperties, cacheStore } = createAuthorizationEnvironment();

  // 1. Missing session token
  const r1 = AuthAuthorization.authorizeRequest('', 'household.view');
  assert.strictEqual(r1.authorized, false);
  assert.strictEqual(r1.authenticated, false);
  assert.strictEqual(r1.errorCode, 'unauthenticated');

  // 2. Malformed session token
  const r2 = AuthAuthorization.authorizeRequest('not-a-valid-hex-token', 'household.view');
  assert.strictEqual(r2.authorized, false);
  assert.strictEqual(r2.authenticated, false);
  assert.strictEqual(r2.errorCode, 'unauthenticated');

  // 3. Unknown session token
  const r3 = AuthAuthorization.authorizeRequest('f'.repeat(96), 'household.view');
  assert.strictEqual(r3.authorized, false);
  assert.strictEqual(r3.authenticated, false);
  assert.strictEqual(r3.errorCode, 'unauthenticated');

  // 4. Active session revoked via FFM-011 revokeSession
  const activeSession = AuthSession.createSession({
    googleSub: '100000000000000000001',
    email: 'owner@example.com',
    emailVerified: true
  });
  assert.strictEqual(AuthAuthorization.authorizeRequest(activeSession.token, 'household.view').authorized, true);

  AuthSession.revokeSession(activeSession.token);
  const r4 = AuthAuthorization.authorizeRequest(activeSession.token, 'household.view');
  assert.strictEqual(r4.authorized, false);
  assert.strictEqual(r4.authenticated, false);
  assert.strictEqual(r4.errorCode, 'unauthenticated');
  assert.strictEqual(r4.sessionError, 'invalid_session');

  // 5. Expired session
  const expiredSession = AuthSession.createSession({
    googleSub: '100000000000000000001',
    email: 'owner@example.com',
    emailVerified: true
  });
  const tokenHash = AuthSession.hashToken(expiredSession.token);
  const storageKey = 'sess_' + tokenHash;
  const record = JSON.parse(mockProperties[storageKey]);
  record.expiresAt = Date.now() - 1000;
  mockProperties[storageKey] = JSON.stringify(record);
  cacheStore[storageKey] = JSON.stringify(record);

  const r5 = AuthAuthorization.authorizeRequest(expiredSession.token, 'household.view');
  assert.strictEqual(r5.authorized, false);
  assert.strictEqual(r5.authenticated, false);
  assert.strictEqual(r5.errorCode, 'unauthenticated');
  assert.strictEqual(r5.sessionError, 'expired_session');
});

// ============================================================================
// 5. Configuration & No-Leakage Security Tests
// ============================================================================

test('AuthAuthorization fails closed on missing or malformed household and membership configuration', () => {
  const badConfigs = [
    // Missing HOUSEHOLD_ID
    { OWNER_EMAIL: 'owner@example.com' },
    // Invalid HOUSEHOLD_ID format
    { HOUSEHOLD_ID: 'invalid household id!', OWNER_EMAIL: 'owner@example.com' },
    // Missing member configuration (even when ALLOWED_EMAILS is present)
    { HOUSEHOLD_ID: 'hh-001', ALLOWED_EMAILS: 'owner@example.com' },
    // Malformed HOUSEHOLD_MEMBERS_JSON
    { HOUSEHOLD_ID: 'hh-001', HOUSEHOLD_MEMBERS_JSON: '{not-valid-json' },
    // Empty array in HOUSEHOLD_MEMBERS_JSON
    { HOUSEHOLD_ID: 'hh-001', HOUSEHOLD_MEMBERS_JSON: '[]' },
    // Member record missing both email and google_sub
    { HOUSEHOLD_ID: 'hh-001', HOUSEHOLD_MEMBERS_JSON: JSON.stringify([{ role: 'OWNER', status: 'ACTIVE' }]) },
    // Member record with malformed email
    { HOUSEHOLD_ID: 'hh-001', HOUSEHOLD_MEMBERS_JSON: JSON.stringify([{ email: 'not-an-email', role: 'OWNER' }]) },
    // Flat property with malformed email
    { HOUSEHOLD_ID: 'hh-001', OWNER_EMAIL: 'bad-email-format' },
    // Malformed HOUSEHOLD_CONFIG_JSON
    { HOUSEHOLD_CONFIG_JSON: 'invalid-json' }
  ];

  for (let i = 0; i < badConfigs.length; i++) {
    const { AuthSession, AuthAuthorization } = createAuthorizationEnvironment({
      properties: badConfigs[i]
    });

    const session = AuthSession.createSession({
      googleSub: '100000000000000000001',
      email: 'owner@example.com',
      emailVerified: true
    });

    const res = AuthAuthorization.authorizeRequest(session.token, 'household.view');
    assert.strictEqual(res.authorized, false, `Bad config index ${i} must fail closed`);
    assert.strictEqual(res.errorCode, 'authorization_configuration_error');
    assert.strictEqual(res.errorMessage, 'You are not authorized to perform this operation.');
  }
});

test('AuthAuthorization responses never leak spreadsheet IDs, other members, or session tokens', () => {
  const { AuthSession, AuthAuthorization, apiGetHouseholdContext, apiAuthorizeOperation } = createAuthorizationEnvironment();

  const ownerSession = AuthSession.createSession({
    googleSub: '100000000000000000001',
    email: 'owner@example.com',
    emailVerified: true,
    name: 'Household Owner'
  });
  const tokenHash = AuthSession.hashToken(ownerSession.token);

  const ctxResponse = apiGetHouseholdContext(ownerSession.token);
  assert.strictEqual(ctxResponse.authorized, true);
  assert.strictEqual(ctxResponse.role, 'OWNER');

  const serializedSuccess = JSON.stringify(ctxResponse);
  // Must not leak spreadsheet ID, partner's email/sub, raw session token, or tokenHash
  assert.strictEqual(serializedSuccess.indexOf('1SecretPrivateSpreadsheetIdDoNotExpose999'), -1);
  assert.strictEqual(serializedSuccess.indexOf('partner@example.com'), -1);
  assert.strictEqual(serializedSuccess.indexOf('100000000000000000002'), -1);
  assert.strictEqual(serializedSuccess.indexOf(ownerSession.token), -1);
  assert.strictEqual(serializedSuccess.indexOf(tokenHash), -1);

  // Test apiAuthorizeOperation for PARTNER
  const partnerSession = AuthSession.createSession({
    googleSub: '100000000000000000002',
    email: 'partner@example.com',
    emailVerified: true
  });

  const allowedOp = apiAuthorizeOperation(partnerSession.token, 'transaction.create', {
    householdId: 'hh-family-001'
  });
  assert.strictEqual(allowedOp.authorized, true);
  assert.strictEqual(allowedOp.role, 'PARTNER');

  const deniedOp = apiAuthorizeOperation(partnerSession.token, 'household.member.manage');
  assert.strictEqual(deniedOp.authorized, false);
  assert.strictEqual(deniedOp.errorCode, 'permission_denied');

  const serializedDenied = JSON.stringify(deniedOp);
  assert.strictEqual(serializedDenied.indexOf('1SecretPrivateSpreadsheetIdDoNotExpose999'), -1);
  assert.strictEqual(serializedDenied.indexOf('owner@example.com'), -1);
  assert.strictEqual(serializedDenied.indexOf(partnerSession.token), -1);
});
