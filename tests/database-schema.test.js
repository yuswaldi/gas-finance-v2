/**
 * Unit and Integration tests for SchemaRegistry (src/database/schema-registry.js)
 * and SchemaMigrations (src/database/migrations.js) — FFM-013.
 *
 * Covers:
 * - All 29 canonical worksheets and exact header definitions from database-schema.md.
 * - Registry immutability, uniqueness, and deterministic ordering.
 * - Schema version validation, future version rejection, and downgrade protection.
 * - Migration registry ordering, uniqueness, and pending selection.
 * - Disposable Google Sheets harness integration: initial migration, idempotency,
 *   missing worksheet creation, existing valid/populated worksheet preservation,
 *   ambiguous unversioned data detection, header mismatch failure without data loss,
 *   partial failure recovery/resume, lock acquisition/release, and OWNER-only API protection.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

/**
 * In-memory disposable Google Spreadsheet mock implementing Apps Script Spreadsheet, Sheet, and Range APIs.
 */
function createDisposableSpreadsheet(initialSheets, options) {
  const sheetsMap = new Map();
  const opts = options || {};
  let insertCount = 0;

  function createSheetObject(name, initialGrid) {
    // grid is a 2D array of values (rows x cols)
    const grid = Array.isArray(initialGrid)
      ? initialGrid.map(row => row.slice())
      : [];
    let frozenRows = 0;
    let setValuesCalls = 0;

    return {
      getName: () => name,
      getLastRow: () => grid.length,
      getLastColumn: () => {
        let maxCol = 0;
        for (let r = 0; r < grid.length; r++) {
          if (grid[r] && grid[r].length > maxCol) {
            maxCol = grid[r].length;
          }
        }
        return maxCol;
      },
      setFrozenRows: (rows) => {
        frozenRows = rows;
      },
      getFrozenRows: () => frozenRows,
      getSetValuesCalls: () => setValuesCalls,
      getRawGrid: () => grid.map(row => row.slice()),
      getRange: (row, col, numRows, numCols) => {
        const rStart = row - 1;
        const cStart = col - 1;
        const rCount = numRows || 1;
        const cCount = numCols || 1;

        return {
          getValues: () => {
            const result = [];
            for (let r = 0; r < rCount; r++) {
              const rowArr = [];
              const srcRow = grid[rStart + r] || [];
              for (let c = 0; c < cCount; c++) {
                const val = srcRow[cStart + c];
                rowArr.push(val !== undefined ? val : '');
              }
              result.push(rowArr);
            }
            return result;
          },
          setValues: (values2D) => {
            setValuesCalls++;
            for (let r = 0; r < values2D.length; r++) {
              const targetRowIdx = rStart + r;
              while (grid.length <= targetRowIdx) {
                grid.push([]);
              }
              for (let c = 0; c < values2D[r].length; c++) {
                const targetColIdx = cStart + c;
                while (grid[targetRowIdx].length < targetColIdx) {
                  grid[targetRowIdx].push('');
                }
                grid[targetRowIdx][targetColIdx] = values2D[r][c];
              }
            }
          }
        };
      }
    };
  }

  if (initialSheets && typeof initialSheets === 'object') {
    const names = Object.keys(initialSheets);
    for (let i = 0; i < names.length; i++) {
      const sName = names[i];
      sheetsMap.set(sName, createSheetObject(sName, initialSheets[sName]));
    }
  }

  return {
    getSheetByName: (name) => (sheetsMap.has(name) ? sheetsMap.get(name) : null),
    getSheets: () => Array.from(sheetsMap.values()),
    insertSheet: (name) => {
      insertCount++;
      if (opts.failOnInsertCount && insertCount === opts.failOnInsertCount) {
        throw new Error('Simulated SpreadsheetApp failure while inserting worksheet ' + name);
      }
      if (sheetsMap.has(name)) {
        throw new Error('Duplicate worksheet name: ' + name);
      }
      const newSheet = createSheetObject(name, []);
      sheetsMap.set(name, newSheet);
      return newSheet;
    },
    getSheetCount: () => sheetsMap.size
  };
}

function createSchemaTestEnvironment(options) {
  const opts = options || {};
  const mockProperties = opts.properties || {
    DB_SPREADSHEET_ID: 'disposable-dev-sheet-001',
    HOUSEHOLD_ID: 'hh-family-001',
    HOUSEHOLD_NAME: 'Utama Family Household',
    OWNER_EMAIL: 'owner@example.com',
    OWNER_GOOGLE_SUB: 'sub-owner-001',
    PARTNER_EMAIL: 'partner@example.com',
    PARTNER_GOOGLE_SUB: 'sub-partner-002'
  };
  const cacheStore = opts.cache || {};
  const disposableSpreadsheet = opts.spreadsheet || createDisposableSpreadsheet();
  let lockHeld = opts.initialLockHeld === true;
  let lockAcquireCount = 0;
  let lockReleaseCount = 0;
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
        tryLock: (_timeoutMs) => {
          lockAcquireCount++;
          if (lockHeld) {
            return false;
          }
          lockHeld = true;
          return true;
        },
        releaseLock: () => {
          lockReleaseCount++;
          lockHeld = false;
        }
      })
    },
    SpreadsheetApp: {
      openById: (id) => {
        if (id !== mockProperties.DB_SPREADSHEET_ID) {
          throw new Error('Spreadsheet not found');
        }
        return disposableSpreadsheet;
      }
    },
    Utilities: {
      getUuid: () => {
        const id = String(uuidCounter++).padStart(4, '0');
        return `33333333-4444-4000-8000-${id}${id}${id}`;
      },
      computeDigest: (_algorithm, value, charset) => {
        const encoding = (charset === 'US_ASCII') ? 'ascii' : 'utf8';
        const hash = crypto.createHash('sha256').update(value, encoding).digest();
        return Array.from(hash).map(b => (b > 127 ? b - 256 : b));
      },
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { US_ASCII: 'US_ASCII', UTF_8: 'UTF_8' }
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
    Logger: { log: () => {} },
    Date: Date,
    JSON: JSON,
    Math: Math,
    Number: Number,
    String: String,
    isNaN: isNaN,
    Error: Error
  };

  vm.createContext(context);
  vm.runInContext(fs.readFileSync('src/auth/allowlist.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/auth/session.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/auth/authorization.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/database/schema-registry.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/database/migrations.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/ui/webapp.js', 'utf8'), context);

  return {
    SchemaRegistry: context.SchemaRegistry,
    SchemaMigrations: context.SchemaMigrations,
    AuthSession: context.AuthSession,
    AuthAuthorization: context.AuthAuthorization,
    apiRunDatabaseMigrations: context.apiRunDatabaseMigrations,
    mockProperties,
    disposableSpreadsheet,
    getLockState: () => ({
      lockHeld,
      lockAcquireCount,
      lockReleaseCount
    })
  };
}

// ============================================================================
// 1. Unit Tests: SchemaRegistry
// ============================================================================

test('SchemaRegistry contains all 29 canonical worksheets in exact order matching database-schema.md', () => {
  const { SchemaRegistry } = createSchemaTestEnvironment();

  const expectedOrder = [
    'USERS',
    'HOUSEHOLD_MEMBERS',
    'ACCOUNTS',
    'CATEGORIES',
    'TRANSACTIONS',
    'TRANSACTION_ENTRIES',
    'TRANSACTION_TAGS',
    'BUDGETS',
    'BUDGET_ITEMS',
    'RECURRING_RULES',
    'BILLS',
    'BILL_PAYMENTS',
    'SAVINGS_GOALS',
    'GOAL_CONTRIBUTIONS',
    'LIABILITIES',
    'DEBT_PAYMENTS',
    'ASSETS',
    'ASSET_VALUATIONS',
    'INVESTMENTS',
    'INVESTMENT_TRANSACTIONS',
    'ATTACHMENTS',
    'NOTIFICATIONS',
    'AUDIT_LOGS',
    'SYSTEM_SETTINGS',
    'JOB_LOGS',
    'USER_SESSIONS',
    'TRANSACTION_OPERATIONS',
    'LOGIN_NONCES',
    'LOGIN_LOGS'
  ];

  const names = Array.from(SchemaRegistry.getWorksheetNames());
  assert.strictEqual(names.length, 29);
  assert.deepStrictEqual(names, expectedOrder);
  assert.strictEqual(SchemaRegistry.getCurrentVersion(), 1);

  const integrity = SchemaRegistry.validateRegistryIntegrity();
  assert.strictEqual(integrity.valid, true);
  assert.deepStrictEqual(Array.from(integrity.errors), []);
});

test('SchemaRegistry definitions match exact column names, order, and immutability', () => {
  const { SchemaRegistry } = createSchemaTestEnvironment();

  assert.strictEqual(Object.isFrozen(SchemaRegistry), true);
  assert.strictEqual(Object.isFrozen(SchemaRegistry.WORKSHEET_NAMES), true);
  assert.strictEqual(Object.isFrozen(SchemaRegistry.WORKSHEETS), true);

  // Spot check key worksheets against database-schema.md
  assert.deepStrictEqual(Array.from(SchemaRegistry.getHeaders('USERS')), [
    'user_id', 'google_sub', 'email', 'email_verified', 'full_name',
    'photo_url', 'status', 'last_login_at', 'created_at', 'updated_at'
  ]);
  assert.deepStrictEqual(Array.from(SchemaRegistry.getHeaders('HOUSEHOLD_MEMBERS')), [
    'membership_id', 'household_id', 'user_id', 'role', 'status',
    'joined_at', 'created_at', 'updated_at'
  ]);
  assert.deepStrictEqual(Array.from(SchemaRegistry.getHeaders('TRANSACTIONS')), [
    'transaction_id', 'household_id', 'transaction_number', 'transaction_type',
    'transaction_date', 'description', 'total_amount', 'status', 'notes',
    'created_by', 'updated_by', 'posted_at', 'voided_at', 'created_at', 'updated_at'
  ]);
  assert.deepStrictEqual(Array.from(SchemaRegistry.getHeaders('TRANSACTION_ENTRIES')), [
    'entry_id', 'household_id', 'transaction_id', 'account_id',
    'category_id', 'entry_type', 'amount', 'description', 'created_at'
  ]);
  assert.deepStrictEqual(Array.from(SchemaRegistry.getHeaders('TRANSACTION_OPERATIONS')), [
    'operation_id', 'household_id', 'transaction_id', 'idempotency_key',
    'operation_type', 'operation_status', 'started_at', 'completed_at',
    'error_message', 'recovery_attempts'
  ]);
  assert.deepStrictEqual(Array.from(SchemaRegistry.getHeaders('LOGIN_LOGS')), [
    'login_log_id', 'user_id', 'email_snapshot', 'event_type',
    'result', 'reason_code', 'occurred_at', 'correlation_id'
  ]);

  // Verify every worksheet has unique headers and is frozen
  const allDefs = SchemaRegistry.getAllWorksheetDefinitions();
  assert.strictEqual(allDefs.length, 29);
  for (let i = 0; i < allDefs.length; i++) {
    const def = allDefs[i];
    assert.strictEqual(Object.isFrozen(def), true);
    assert.strictEqual(Object.isFrozen(def.headers), true);
    const uniqueHeaders = new Set(def.headers);
    assert.strictEqual(uniqueHeaders.size, def.headers.length, `Duplicate header in ${def.name}`);
  }

  // Mutating returned array copy must not mutate internal registry
  const usersHeadersCopy = SchemaRegistry.getHeaders('USERS');
  usersHeadersCopy.push('hacked_column');
  assert.strictEqual(SchemaRegistry.getHeaders('USERS').length, 10);
});

test('SchemaRegistry.validateWorksheetHeaders detects missing, unknown, renamed, and reordered headers', () => {
  const { SchemaRegistry } = createSchemaTestEnvironment();
  const canonicalUsers = Array.from(SchemaRegistry.getHeaders('USERS'));

  // 1. Exact match passes
  const exactRes = SchemaRegistry.validateWorksheetHeaders('USERS', canonicalUsers);
  assert.strictEqual(exactRes.valid, true);

  // 2. Missing column fails
  const missingCol = canonicalUsers.slice(0, -1);
  const missingRes = SchemaRegistry.validateWorksheetHeaders('USERS', missingCol);
  assert.strictEqual(missingRes.valid, false);
  assert.strictEqual(missingRes.errorCode, 'header_mismatch');
  assert.deepStrictEqual(Array.from(missingRes.missingColumns), ['updated_at']);

  // 3. Extra unknown column fails and reports unknownColumns
  const extraCol = canonicalUsers.concat(['unexpected_extra_col']);
  const extraRes = SchemaRegistry.validateWorksheetHeaders('USERS', extraCol);
  assert.strictEqual(extraRes.valid, false);
  assert.strictEqual(extraRes.errorCode, 'header_mismatch');
  assert.deepStrictEqual(Array.from(extraRes.unknownColumns), ['unexpected_extra_col']);

  // 4. Reordered columns fail even when all column names exist
  const reordered = canonicalUsers.slice();
  const tmp = reordered[1];
  reordered[1] = reordered[2];
  reordered[2] = tmp;
  const reorderRes = SchemaRegistry.validateWorksheetHeaders('USERS', reordered);
  assert.strictEqual(reorderRes.valid, false);
  assert.strictEqual(reorderRes.errorCode, 'header_mismatch');
  assert.strictEqual(reorderRes.missingColumns.length, 0);
  assert.strictEqual(reorderRes.unknownColumns.length, 0);
  assert.ok(reorderRes.orderMismatches.length >= 2);

  // 5. Empty header row fails with empty_headers
  const emptyRes = SchemaRegistry.validateWorksheetHeaders('USERS', ['', '   ']);
  assert.strictEqual(emptyRes.valid, false);
  assert.strictEqual(emptyRes.isEmpty, true);
  assert.strictEqual(emptyRes.errorCode, 'empty_headers');

  // 6. Unknown worksheet name fails with unknown_worksheet
  const unknownRes = SchemaRegistry.validateWorksheetHeaders('NON_EXISTENT_SHEET', ['id']);
  assert.strictEqual(unknownRes.valid, false);
  assert.strictEqual(unknownRes.errorCode, 'unknown_worksheet');
});

// ============================================================================
// 2. Unit Tests: Schema Versioning & Migration Registry
// ============================================================================

test('SchemaMigrations validates persisted SCHEMA_VERSION and rejects invalid or future versions', () => {
  const { SchemaMigrations, mockProperties } = createSchemaTestEnvironment();

  // Uninitialized returns version 0
  const uninit = SchemaMigrations.getSchemaVersion();
  assert.strictEqual(uninit.valid, true);
  assert.strictEqual(uninit.version, 0);
  assert.strictEqual(uninit.initialized, false);

  // Valid version '1'
  mockProperties.SCHEMA_VERSION = '1';
  const v1 = SchemaMigrations.getSchemaVersion();
  assert.strictEqual(v1.valid, true);
  assert.strictEqual(v1.version, 1);
  assert.strictEqual(v1.initialized, true);

  // Invalid format versions
  const invalidValues = ['abc', '-1', '1.5', 'NaN', '1a'];
  for (let i = 0; i < invalidValues.length; i++) {
    mockProperties.SCHEMA_VERSION = invalidValues[i];
    const res = SchemaMigrations.getSchemaVersion();
    assert.strictEqual(res.valid, false, `Value "${invalidValues[i]}" must be rejected`);
    assert.strictEqual(res.errorCode, 'invalid_schema_version');
  }

  // Unknown future schema version
  mockProperties.SCHEMA_VERSION = '2';
  const futureRes = SchemaMigrations.getSchemaVersion();
  assert.strictEqual(futureRes.valid, false);
  assert.strictEqual(futureRes.errorCode, 'unsupported_future_schema_version');

  // Version downgrade is rejected
  const downgradeRes = SchemaMigrations.setSchemaVersion(1, 2, mockProperties, 2);
  assert.strictEqual(downgradeRes.success, false);
  assert.strictEqual(downgradeRes.errorCode, 'schema_version_downgrade_rejected');
});

test('SchemaMigrations validates migration registry ordering and selects pending migrations', () => {
  const { SchemaMigrations } = createSchemaTestEnvironment();

  // Default registry is valid
  const defaultCheck = SchemaMigrations.validateMigrationRegistry();
  assert.strictEqual(defaultCheck.valid, true);
  assert.strictEqual(defaultCheck.maxVersion, 1);

  // Duplicate version is rejected
  const dupRes = SchemaMigrations.validateMigrationRegistry([
    { version: 1, name: 'm1', up: () => ({ success: true }) },
    { version: 1, name: 'm2', up: () => ({ success: true }) }
  ]);
  assert.strictEqual(dupRes.valid, false);
  assert.strictEqual(dupRes.errorCode, 'duplicate_migration_version');

  // Unordered version is rejected
  const unorderedRes = SchemaMigrations.validateMigrationRegistry([
    { version: 2, name: 'm2', up: () => ({ success: true }) },
    { version: 1, name: 'm1', up: () => ({ success: true }) }
  ]);
  assert.strictEqual(unorderedRes.valid, false);
  assert.strictEqual(unorderedRes.errorCode, 'unordered_migration_versions');

  // Pending migration selection across multiple versions
  const multiMigrations = [
    { version: 1, name: '001_init', up: () => ({ success: true }) },
    { version: 2, name: '002_next', up: () => ({ success: true }) },
    { version: 3, name: '003_later', up: () => ({ success: true }) }
  ];

  const from0 = SchemaMigrations.getPendingMigrations(0, multiMigrations);
  assert.strictEqual(from0.valid, true);
  assert.strictEqual(from0.pending.length, 3);

  const from1 = SchemaMigrations.getPendingMigrations(1, multiMigrations);
  assert.strictEqual(from1.valid, true);
  assert.strictEqual(from1.pending.length, 2);
  assert.strictEqual(from1.pending[0].version, 2);
  assert.strictEqual(from1.pending[1].version, 3);

  const from3 = SchemaMigrations.getPendingMigrations(3, multiMigrations);
  assert.strictEqual(from3.valid, true);
  assert.strictEqual(from3.pending.length, 0);
});

// ============================================================================
// 3. Integration Tests: Disposable DEV Spreadsheet Migration Lifecycle
// ============================================================================

test('Initial migration on clean empty DEV spreadsheet creates all 29 worksheets and persists SCHEMA_VERSION=1', () => {
  const { SchemaRegistry, SchemaMigrations, mockProperties, disposableSpreadsheet, getLockState } = createSchemaTestEnvironment();

  assert.strictEqual(mockProperties.SCHEMA_VERSION, undefined);
  assert.strictEqual(disposableSpreadsheet.getSheetCount(), 0);

  const result = SchemaMigrations.runMigrations();
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 'migrated');
  assert.strictEqual(result.previousVersion, 0);
  assert.strictEqual(result.currentVersion, 1);
  assert.deepStrictEqual(Array.from(result.appliedMigrations), ['001_initial_canonical_schema']);
  assert.strictEqual(result.worksheetResults.length, 29);

  // Verify SCHEMA_VERSION was persisted in Script Properties
  assert.strictEqual(mockProperties.SCHEMA_VERSION, '1');

  // Verify all 29 worksheets exist with exact headers and frozen row 1
  const expectedNames = SchemaRegistry.getWorksheetNames();
  assert.strictEqual(disposableSpreadsheet.getSheetCount(), 29);
  for (let i = 0; i < expectedNames.length; i++) {
    const name = expectedNames[i];
    const sheet = disposableSpreadsheet.getSheetByName(name);
    assert.ok(sheet, `Worksheet ${name} must exist`);
    assert.strictEqual(sheet.getLastRow(), 1);
    assert.strictEqual(sheet.getFrozenRows(), 1);
    const actualHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    assert.deepStrictEqual(Array.from(actualHeaders), Array.from(SchemaRegistry.getHeaders(name)));
  }

  // Verify lock was acquired and released
  const lockState = getLockState();
  assert.strictEqual(lockState.lockHeld, false);
  assert.strictEqual(lockState.lockAcquireCount, 1);
  assert.strictEqual(lockState.lockReleaseCount, 1);
});

test('Re-running initial migration is idempotent and does not duplicate worksheets or header rows', () => {
  const { SchemaMigrations, mockProperties, disposableSpreadsheet } = createSchemaTestEnvironment();

  // First run initializes schema
  const firstRun = SchemaMigrations.runMigrations();
  assert.strictEqual(firstRun.success, true);
  assert.strictEqual(firstRun.status, 'migrated');

  // Second run detects schema is already at version 1 and validates headers without writing
  const secondRun = SchemaMigrations.runMigrations();
  assert.strictEqual(secondRun.success, true);
  assert.strictEqual(secondRun.status, 'up_to_date');
  assert.strictEqual(secondRun.previousVersion, 1);
  assert.strictEqual(secondRun.currentVersion, 1);
  assert.deepStrictEqual(Array.from(secondRun.appliedMigrations), []);
  assert.strictEqual(mockProperties.SCHEMA_VERSION, '1');
  assert.strictEqual(disposableSpreadsheet.getSheetCount(), 29);

  // Confirm USERS still has only 1 row (no duplicate header row) and setValues was called only once
  const usersSheet = disposableSpreadsheet.getSheetByName('USERS');
  assert.strictEqual(usersSheet.getLastRow(), 1);
  assert.strictEqual(usersSheet.getSetValuesCalls(), 1);
});

test('Migration creates missing worksheets while preserving existing valid and empty worksheets', () => {
  const { SchemaRegistry, SchemaMigrations } = createSchemaTestEnvironment();

  // Pre-seed a spreadsheet with:
  // - 'USERS' already having valid headers
  // - 'ACCOUNTS' existing as a genuinely empty (0x0) worksheet
  const preSeededSpreadsheet = createDisposableSpreadsheet({
    USERS: [SchemaRegistry.getHeaders('USERS')],
    ACCOUNTS: []
  });

  const env = createSchemaTestEnvironment({ spreadsheet: preSeededSpreadsheet });
  const result = env.SchemaMigrations.runMigrations();

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 'migrated');
  assert.strictEqual(preSeededSpreadsheet.getSheetCount(), 29);

  const usersResult = result.worksheetResults.find(r => r.worksheet === 'USERS');
  const accountsResult = result.worksheetResults.find(r => r.worksheet === 'ACCOUNTS');
  const transactionsResult = result.worksheetResults.find(r => r.worksheet === 'TRANSACTIONS');

  assert.strictEqual(usersResult.action, 'preserved');
  assert.strictEqual(accountsResult.action, 'initialized_empty');
  assert.strictEqual(transactionsResult.action, 'created');

  // Pre-existing valid USERS sheet was never overwritten
  assert.strictEqual(preSeededSpreadsheet.getSheetByName('USERS').getSetValuesCalls(), 0);
});

test('Migration detects ambiguous unversioned pre-populated spreadsheet and fails safely without data loss', () => {
  const { SchemaRegistry } = createSchemaTestEnvironment();
  const sampleUserRow = [
    'usr-001', 'sub-001', 'owner@example.com', true, 'Owner Name',
    '', 'ACTIVE', '2026-11-26T00:00:00Z', '2026-11-26T00:00:00Z', '2026-11-26T00:00:00Z'
  ];

  // Spreadsheet has data in row 2 of USERS, but SCHEMA_VERSION is not set
  const populatedSpreadsheet = createDisposableSpreadsheet({
    USERS: [
      SchemaRegistry.getHeaders('USERS'),
      sampleUserRow
    ]
  });

  const env = createSchemaTestEnvironment({ spreadsheet: populatedSpreadsheet });
  const result = env.SchemaMigrations.runMigrations();

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.errorCode, 'ambiguous_unversioned_database');
  assert.strictEqual(env.mockProperties.SCHEMA_VERSION, undefined);

  // Confirm existing data in USERS was not deleted or modified
  const usersGrid = populatedSpreadsheet.getSheetByName('USERS').getRawGrid();
  assert.strictEqual(usersGrid.length, 2);
  assert.deepStrictEqual(usersGrid[1], sampleUserRow);

  // When explicit baseline adoption is authorized (adoptExistingBaseline: true),
  // the populated worksheet is preserved intact and missing worksheets are created
  const adoptedResult = env.SchemaMigrations.runMigrations({ adoptExistingBaseline: true });
  assert.strictEqual(adoptedResult.success, true);
  assert.strictEqual(adoptedResult.currentVersion, 1);
  assert.strictEqual(env.mockProperties.SCHEMA_VERSION, '1');
  const preservedGrid = populatedSpreadsheet.getSheetByName('USERS').getRawGrid();
  assert.strictEqual(preservedGrid.length, 2);
  assert.deepStrictEqual(preservedGrid[1], sampleUserRow);
});

test('Existing header mismatch fails safely without overwriting headers, removing unknown columns, or advancing SCHEMA_VERSION', () => {
  const { SchemaRegistry } = createSchemaTestEnvironment();
  // Create CATEGORIES with a renamed column and an extra unknown column
  const badCategoriesHeaders = SchemaRegistry.getHeaders('CATEGORIES').slice();
  badCategoriesHeaders[3] = 'wrong_category_title';
  badCategoriesHeaders.push('custom_user_column');

  const mismatchedSpreadsheet = createDisposableSpreadsheet({
    CATEGORIES: [badCategoriesHeaders]
  });

  const env = createSchemaTestEnvironment({ spreadsheet: mismatchedSpreadsheet });
  const result = env.SchemaMigrations.runMigrations();

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.errorCode, 'header_mismatch');
  assert.ok(result.diagnostic.indexOf('CATEGORIES') !== -1);
  assert.strictEqual(env.mockProperties.SCHEMA_VERSION, undefined);

  // Verify the mismatched headers and unknown column were NOT overwritten or deleted
  const catSheet = mismatchedSpreadsheet.getSheetByName('CATEGORIES');
  assert.strictEqual(catSheet.getSetValuesCalls(), 0);
  assert.deepStrictEqual(catSheet.getRawGrid()[0], badCategoriesHeaders);
});

test('Simulated partial migration failure does not advance SCHEMA_VERSION, releases lock, and safely resumes on retry', () => {
  // Simulate failure on the 12th worksheet insertion
  const flakySpreadsheet = createDisposableSpreadsheet({}, { failOnInsertCount: 12 });
  const env = createSchemaTestEnvironment({ spreadsheet: flakySpreadsheet });

  const failedRun = env.SchemaMigrations.runMigrations();
  assert.strictEqual(failedRun.success, false);
  assert.strictEqual(failedRun.errorCode, 'migration_execution_failed');
  assert.strictEqual(env.mockProperties.SCHEMA_VERSION, undefined);
  assert.strictEqual(flakySpreadsheet.getSheetCount(), 11);

  // Lock must be released even after exception
  assert.strictEqual(env.getLockState().lockHeld, false);

  // Now retry on a spreadsheet holding those 11 partially created worksheets
  const partialSheets = {};
  const existingSheets = flakySpreadsheet.getSheets();
  for (let i = 0; i < existingSheets.length; i++) {
    partialSheets[existingSheets[i].getName()] = existingSheets[i].getRawGrid();
  }
  const resumedSpreadsheet = createDisposableSpreadsheet(partialSheets);
  const retryEnv = createSchemaTestEnvironment({
    spreadsheet: resumedSpreadsheet,
    properties: env.mockProperties
  });

  const retryRun = retryEnv.SchemaMigrations.runMigrations();
  assert.strictEqual(retryRun.success, true);
  assert.strictEqual(retryRun.status, 'migrated');
  assert.strictEqual(retryRun.currentVersion, 1);
  assert.strictEqual(retryEnv.mockProperties.SCHEMA_VERSION, '1');
  assert.strictEqual(resumedSpreadsheet.getSheetCount(), 29);

  // First 11 worksheets were preserved, remaining 18 were created
  const preservedCount = retryRun.worksheetResults.filter(r => r.action === 'preserved').length;
  const createdCount = retryRun.worksheetResults.filter(r => r.action === 'created').length;
  assert.strictEqual(preservedCount, 11);
  assert.strictEqual(createdCount, 18);
});

test('Concurrent migration attempt fails safely with migration_lock_timeout when script lock is held', () => {
  const env = createSchemaTestEnvironment({ initialLockHeld: true });
  const result = env.SchemaMigrations.runMigrations();

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.errorCode, 'migration_lock_timeout');
  assert.strictEqual(env.mockProperties.SCHEMA_VERSION, undefined);
  assert.strictEqual(env.disposableSpreadsheet.getSheetCount(), 0);
});

test('apiRunDatabaseMigrations requires authenticated OWNER session and never leaks DB_SPREADSHEET_ID', () => {
  const { AuthSession, apiRunDatabaseMigrations, mockProperties } = createSchemaTestEnvironment();

  // 1. Unauthenticated request is rejected
  const unauthRes = apiRunDatabaseMigrations('');
  assert.strictEqual(unauthRes.success, false);
  assert.strictEqual(unauthRes.authorized, false);
  assert.strictEqual(unauthRes.errorCode, 'unauthenticated');

  // 2. PARTNER session is rejected with permission_denied
  const partnerSession = AuthSession.createSession({
    googleSub: 'sub-partner-002',
    email: 'partner@example.com',
    emailVerified: true
  });
  const partnerRes = apiRunDatabaseMigrations(partnerSession.token);
  assert.strictEqual(partnerRes.success, false);
  assert.strictEqual(partnerRes.authorized, false);
  assert.strictEqual(partnerRes.errorCode, 'permission_denied');
  assert.strictEqual(mockProperties.SCHEMA_VERSION, undefined);

  // 3. OWNER session succeeds and initializes database schema without leaking DB_SPREADSHEET_ID
  const ownerSession = AuthSession.createSession({
    googleSub: 'sub-owner-001',
    email: 'owner@example.com',
    emailVerified: true
  });
  const ownerRes = apiRunDatabaseMigrations(ownerSession.token);
  assert.strictEqual(ownerRes.success, true);
  assert.strictEqual(ownerRes.authorized, true);
  assert.strictEqual(ownerRes.status, 'migrated');
  assert.strictEqual(ownerRes.currentVersion, 1);
  assert.strictEqual(mockProperties.SCHEMA_VERSION, '1');
  assert.strictEqual(JSON.stringify(ownerRes).indexOf('disposable-dev-sheet-001'), -1);
});
