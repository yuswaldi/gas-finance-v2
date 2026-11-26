/**
 * SchemaMigrations module (FFM-013)
 * Implements schema version tracking, migration registry validation, safe worksheet/header
 * creation, idempotent migration execution, and script-lock concurrency control.
 *
 * Design principles:
 * - Authoritative schema version stored in Script Properties under SCHEMA_VERSION.
 * - Rejects non-integer, negative, corrupted, or unknown future schema versions (fail closed).
 * - Never downgrades SCHEMA_VERSION.
 * - Acquires LockService.getScriptLock() before performing schema changes and always releases in finally.
 * - Never deletes existing worksheets, never clears existing data, and never overwrites mismatched headers.
 * - Fails safely on header mismatch or ambiguous unversioned pre-populated spreadsheet.
 * - Persists new SCHEMA_VERSION only after all migration operations and post-migration schema verification succeed.
 */
var SchemaMigrations = {
  /**
   * Script Property key storing the current integer schema version.
   */
  SCHEMA_VERSION_KEY: 'SCHEMA_VERSION',

  /**
   * Script Property key storing the private Google Spreadsheet ID.
   */
  DB_SPREADSHEET_ID_KEY: 'DB_SPREADSHEET_ID',

  /**
   * Default lock acquisition timeout in milliseconds (10 seconds).
   */
  DEFAULT_LOCK_TIMEOUT_MS: 10000,

  /**
   * Safe generic error message for public/external responses.
   */
  SAFE_ERROR_MESSAGE: 'Database schema operation could not be completed.',

  /**
   * Reads and validates the persisted SCHEMA_VERSION from Script Properties.
   * - Missing or empty property returns { valid: true, version: 0, initialized: false }.
   * - Non-integer or negative values fail closed with 'invalid_schema_version'.
   * - Values greater than maxSupportedVersion fail closed with 'unsupported_future_schema_version'.
   *
   * @param {Object} [customProps] - Optional Script Properties store.
   * @param {number} [maxSupportedVersion] - Optional maximum supported version override.
   * @returns {{
   *   valid: boolean,
   *   version?: number,
   *   initialized?: boolean,
   *   errorCode?: string,
   *   errorMessage?: string,
   *   diagnostic?: string
   * }}
   */
  getSchemaVersion: function(customProps, maxSupportedVersion) {
    var props = customProps;
    if (!props) {
      try {
        props = PropertiesService.getScriptProperties();
      } catch (_err) {
        return {
          valid: false,
          errorCode: 'storage_error',
          errorMessage: 'Unable to access Script Properties for schema version.',
          diagnostic: 'PropertiesService.getScriptProperties() threw an error.'
        };
      }
    }

    if (!props || typeof props.getProperty !== 'function') {
      return {
        valid: false,
        errorCode: 'storage_error',
        errorMessage: 'Script Properties store is unavailable.',
        diagnostic: 'PropertiesService.getScriptProperties() returned null or invalid object.'
      };
    }

    var maxVersion = (typeof maxSupportedVersion === 'number' && Number.isInteger(maxSupportedVersion))
      ? maxSupportedVersion
      : SchemaRegistry.getCurrentVersion();

    var rawValue;
    try {
      rawValue = props.getProperty(this.SCHEMA_VERSION_KEY);
    } catch (_readErr) {
      return {
        valid: false,
        errorCode: 'storage_error',
        errorMessage: 'Failed to read SCHEMA_VERSION from Script Properties.',
        diagnostic: 'props.getProperty(SCHEMA_VERSION) threw an error.'
      };
    }

    if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') {
      return {
        valid: true,
        version: 0,
        initialized: false
      };
    }

    var trimmed = String(rawValue).trim();
    if (!/^\d+$/.test(trimmed)) {
      return {
        valid: false,
        errorCode: 'invalid_schema_version',
        errorMessage: 'Persisted database schema version is invalid.',
        diagnostic: 'SCHEMA_VERSION "' + trimmed + '" is not a valid non-negative integer.'
      };
    }

    var parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return {
        valid: false,
        errorCode: 'invalid_schema_version',
        errorMessage: 'Persisted database schema version is out of range.',
        diagnostic: 'SCHEMA_VERSION is not a safe non-negative integer.'
      };
    }

    if (parsed > maxVersion) {
      return {
        valid: false,
        errorCode: 'unsupported_future_schema_version',
        errorMessage: 'Database schema version is newer than supported by this application build.',
        diagnostic: 'Persisted SCHEMA_VERSION (' + parsed + ') exceeds supported version (' + maxVersion + ').'
      };
    }

    return {
      valid: true,
      version: parsed,
      initialized: parsed > 0
    };
  },

  /**
   * Persists a new schema version to Script Properties.
   * Rejects invalid integers, future versions, or version downgrades.
   *
   * @param {number} newVersion - Version integer to persist.
   * @param {number} [previousVersion] - Previous version to guard against downgrade.
   * @param {Object} [customProps] - Optional Script Properties store.
   * @param {number} [maxSupportedVersion] - Optional maximum supported version override.
   * @returns {{
   *   success: boolean,
   *   version?: number,
   *   errorCode?: string,
   *   errorMessage?: string
   * }}
   */
  setSchemaVersion: function(newVersion, previousVersion, customProps, maxSupportedVersion) {
    var maxVersion = (typeof maxSupportedVersion === 'number' && Number.isInteger(maxSupportedVersion))
      ? maxSupportedVersion
      : SchemaRegistry.getCurrentVersion();

    if (typeof newVersion !== 'number' || !Number.isInteger(newVersion) || newVersion < 1) {
      return {
        success: false,
        errorCode: 'invalid_schema_version',
        errorMessage: 'New schema version must be a positive integer.'
      };
    }

    if (newVersion > maxVersion) {
      return {
        success: false,
        errorCode: 'unsupported_future_schema_version',
        errorMessage: 'Cannot set schema version above maximum supported version.'
      };
    }

    if (typeof previousVersion === 'number' && Number.isInteger(previousVersion) && newVersion < previousVersion) {
      return {
        success: false,
        errorCode: 'schema_version_downgrade_rejected',
        errorMessage: 'Downgrading SCHEMA_VERSION is prohibited.'
      };
    }

    var props = customProps;
    if (!props) {
      try {
        props = PropertiesService.getScriptProperties();
      } catch (_err) {
        return {
          success: false,
          errorCode: 'storage_error',
          errorMessage: 'Unable to access Script Properties to persist schema version.'
        };
      }
    }

    if (!props || typeof props.setProperty !== 'function') {
      return {
        success: false,
        errorCode: 'storage_error',
        errorMessage: 'Script Properties store is unavailable.'
      };
    }

    try {
      props.setProperty(this.SCHEMA_VERSION_KEY, String(newVersion));
      return {
        success: true,
        version: newVersion
      };
    } catch (_writeErr) {
      return {
        success: false,
        errorCode: 'storage_error',
        errorMessage: 'Failed to write SCHEMA_VERSION to Script Properties.'
      };
    }
  },

  /**
   * Opens the environment-configured Google Spreadsheet using DB_SPREADSHEET_ID from Script Properties.
   * Never exposes the spreadsheet ID in returned error messages or diagnostics.
   *
   * @param {Object} [customProps] - Optional Script Properties store.
   * @returns {{
   *   success: boolean,
   *   spreadsheet?: Object,
   *   errorCode?: string,
   *   errorMessage?: string
   * }}
   */
  openConfiguredSpreadsheet: function(customProps) {
    var props = customProps;
    if (!props) {
      try {
        props = PropertiesService.getScriptProperties();
      } catch (_err) {
        return {
          success: false,
          errorCode: 'database_configuration_error',
          errorMessage: 'Unable to access Script Properties for database configuration.'
        };
      }
    }

    if (!props || typeof props.getProperty !== 'function') {
      return {
        success: false,
        errorCode: 'database_configuration_error',
        errorMessage: 'Script Properties store is unavailable.'
      };
    }

    var rawId = props.getProperty(this.DB_SPREADSHEET_ID_KEY);
    var spreadsheetId = (rawId !== null && rawId !== undefined) ? String(rawId).trim() : '';
    if (!spreadsheetId) {
      return {
        success: false,
        errorCode: 'database_configuration_error',
        errorMessage: 'DB_SPREADSHEET_ID is not configured in Script Properties.'
      };
    }

    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp || typeof SpreadsheetApp.openById !== 'function') {
      return {
        success: false,
        errorCode: 'spreadsheet_service_unavailable',
        errorMessage: 'SpreadsheetApp service is unavailable in the current context.'
      };
    }

    try {
      var ss = SpreadsheetApp.openById(spreadsheetId);
      if (!ss) {
        return {
          success: false,
          errorCode: 'spreadsheet_open_failed',
          errorMessage: 'Target database spreadsheet could not be opened.'
        };
      }
      return {
        success: true,
        spreadsheet: ss
      };
    } catch (_openErr) {
      return {
        success: false,
        errorCode: 'spreadsheet_open_failed',
        errorMessage: 'Failed to open configured database spreadsheet.'
      };
    }
  },

  /**
   * Safely ensures a single worksheet exists and has valid canonical headers.
   * - If missing: creates the worksheet and writes the canonical header row in one batch setValues() call.
   * - If present and genuinely empty (lastRow === 0 && lastColumn === 0): writes canonical header row.
   * - If present and non-empty: validates row 1 headers against canonical definition without modifying headers or data.
   *
   * @param {Object} spreadsheet - Apps Script Spreadsheet object.
   * @param {Object} worksheetDef - Canonical worksheet definition from SchemaRegistry.
   * @returns {{
   *   valid: boolean,
   *   worksheet: string,
   *   action: string,
   *   rowCount?: number,
   *   errorCode?: string,
   *   diagnostic?: string,
   *   details?: Object
   * }}
   */
  ensureWorksheet: function(spreadsheet, worksheetDef) {
    if (!spreadsheet || typeof spreadsheet.getSheetByName !== 'function' || typeof spreadsheet.insertSheet !== 'function') {
      return {
        valid: false,
        worksheet: worksheetDef ? worksheetDef.name : '',
        action: 'error',
        errorCode: 'invalid_spreadsheet',
        diagnostic: 'Invalid spreadsheet instance provided to ensureWorksheet.'
      };
    }

    if (!worksheetDef || !worksheetDef.name || !Array.isArray(worksheetDef.headers)) {
      return {
        valid: false,
        worksheet: '',
        action: 'error',
        errorCode: 'invalid_worksheet_definition',
        diagnostic: 'Invalid worksheet definition provided to ensureWorksheet.'
      };
    }

    var sheetName = worksheetDef.name;
    var expectedHeaders = worksheetDef.headers.slice();
    var sheet = spreadsheet.getSheetByName(sheetName);

    // Case 1: Worksheet does not exist -> create and initialize headers
    if (!sheet) {
      sheet = spreadsheet.insertSheet(sheetName);
      sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
      if (typeof sheet.setFrozenRows === 'function') {
        sheet.setFrozenRows(1);
      }

      var writtenRow = sheet.getRange(1, 1, 1, expectedHeaders.length).getValues()[0];
      var verifyNew = SchemaRegistry.validateWorksheetHeaders(sheetName, writtenRow);
      if (!verifyNew.valid) {
        return {
          valid: false,
          worksheet: sheetName,
          action: 'failed_verification',
          errorCode: verifyNew.errorCode || 'header_mismatch',
          diagnostic: verifyNew.diagnostic,
          details: verifyNew
        };
      }

      return {
        valid: true,
        worksheet: sheetName,
        action: 'created',
        rowCount: 1
      };
    }

    // Case 2: Worksheet exists -> check if genuinely empty
    var lastRow = typeof sheet.getLastRow === 'function' ? sheet.getLastRow() : 0;
    var lastCol = typeof sheet.getLastColumn === 'function' ? sheet.getLastColumn() : 0;

    if (lastRow === 0 && lastCol === 0) {
      sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
      if (typeof sheet.setFrozenRows === 'function') {
        sheet.setFrozenRows(1);
      }

      var initRow = sheet.getRange(1, 1, 1, expectedHeaders.length).getValues()[0];
      var verifyInit = SchemaRegistry.validateWorksheetHeaders(sheetName, initRow);
      if (!verifyInit.valid) {
        return {
          valid: false,
          worksheet: sheetName,
          action: 'failed_verification',
          errorCode: verifyInit.errorCode || 'header_mismatch',
          diagnostic: verifyInit.diagnostic,
          details: verifyInit
        };
      }

      return {
        valid: true,
        worksheet: sheetName,
        action: 'initialized_empty',
        rowCount: 1
      };
    }

    // Case 3: Worksheet exists and has content -> validate headers without overwriting or clearing data
    var actualRow = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    var validation = SchemaRegistry.validateWorksheetHeaders(sheetName, actualRow);
    if (!validation.valid) {
      return {
        valid: false,
        worksheet: sheetName,
        action: 'failed_validation',
        rowCount: lastRow,
        errorCode: validation.errorCode || 'header_mismatch',
        diagnostic: validation.diagnostic,
        details: validation
      };
    }

    return {
      valid: true,
      worksheet: sheetName,
      action: 'preserved',
      rowCount: lastRow
    };
  },

  /**
   * Validates all canonical worksheets and headers in a spreadsheet against SchemaRegistry.
   * Performs read-only verification without modifying any worksheet.
   *
   * @param {Object} spreadsheet - Apps Script Spreadsheet object.
   * @returns {{
   *   valid: boolean,
   *   checkedCount: number,
   *   validCount: number,
   *   errors: Array<Object>,
   *   diagnostic: string
   * }}
   */
  validateDatabaseSchema: function(spreadsheet) {
    if (!spreadsheet || typeof spreadsheet.getSheetByName !== 'function') {
      return {
        valid: false,
        checkedCount: 0,
        validCount: 0,
        errors: [
          {
            worksheet: '',
            errorCode: 'invalid_spreadsheet',
            diagnostic: 'Invalid spreadsheet object passed to validateDatabaseSchema.'
          }
        ],
        diagnostic: 'Invalid spreadsheet object passed to validateDatabaseSchema.'
      };
    }

    var definitions = SchemaRegistry.getAllWorksheetDefinitions();
    var errors = [];

    for (var i = 0; i < definitions.length; i++) {
      var def = definitions[i];
      var sheet = spreadsheet.getSheetByName(def.name);
      if (!sheet) {
        errors.push({
          worksheet: def.name,
          errorCode: 'missing_worksheet',
          diagnostic: 'Required worksheet "' + def.name + '" is missing.'
        });
        continue;
      }

      var lastRow = typeof sheet.getLastRow === 'function' ? sheet.getLastRow() : 0;
      var lastCol = typeof sheet.getLastColumn === 'function' ? sheet.getLastColumn() : 0;
      if (lastRow === 0 || lastCol === 0) {
        errors.push({
          worksheet: def.name,
          errorCode: 'empty_headers',
          diagnostic: 'Worksheet "' + def.name + '" has an empty header row.'
        });
        continue;
      }

      var actualHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
      var headerCheck = SchemaRegistry.validateWorksheetHeaders(def.name, actualHeaders);
      if (!headerCheck.valid) {
        errors.push({
          worksheet: def.name,
          errorCode: headerCheck.errorCode || 'header_mismatch',
          diagnostic: headerCheck.diagnostic,
          details: headerCheck
        });
      }
    }

    return {
      valid: errors.length === 0,
      checkedCount: definitions.length,
      validCount: definitions.length - errors.length,
      errors: errors,
      diagnostic: errors.length === 0
        ? 'All ' + definitions.length + ' canonical worksheets and headers verified.'
        : ('Schema validation failed with ' + errors.length + ' issue(s): ' + errors[0].diagnostic)
    };
  },

  /**
   * Authoritative versioned migration list.
   * Each migration has a unique ascending integer version, name, description,
   * isApplied check, and idempotent up(spreadsheet) execution function.
   */
  MIGRATIONS: [
    {
      version: 1,
      name: '001_initial_canonical_schema',
      description: 'Create and verify all 29 canonical worksheets and exact header rows defined in database-schema.md.',
      isApplied: function(spreadsheet) {
        var check = SchemaMigrations.validateDatabaseSchema(spreadsheet);
        return check.valid;
      },
      up: function(spreadsheet) {
        var definitions = SchemaRegistry.getAllWorksheetDefinitions();
        var worksheetResults = [];

        for (var i = 0; i < definitions.length; i++) {
          var res = SchemaMigrations.ensureWorksheet(spreadsheet, definitions[i]);
          worksheetResults.push(res);
          if (!res.valid) {
            return {
              success: false,
              errorCode: res.errorCode || 'header_mismatch',
              diagnostic: res.diagnostic || ('Failed to initialize worksheet "' + definitions[i].name + '".'),
              worksheet: definitions[i].name,
              worksheetResults: worksheetResults
            };
          }
        }

        return {
          success: true,
          worksheetResults: worksheetResults
        };
      }
    }
  ],

  /**
   * Validates a migration definitions list for unique, positive, strictly ascending versions
   * and required handler functions.
   *
   * @param {Array<Object>} [migrationsList] - Optional migration array (defaults to this.MIGRATIONS).
   * @returns {{
   *   valid: boolean,
   *   migrations?: Array<Object>,
   *   maxVersion?: number,
   *   errorCode?: string,
   *   diagnostic?: string
   * }}
   */
  validateMigrationRegistry: function(migrationsList) {
    var list = migrationsList !== undefined ? migrationsList : this.MIGRATIONS;
    if (!Array.isArray(list) || list.length === 0) {
      return {
        valid: false,
        errorCode: 'invalid_migration_registry',
        diagnostic: 'Migration registry must be a non-empty array.'
      };
    }

    var seenVersions = {};
    var seenNames = {};
    var prevVersion = 0;

    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (!m || typeof m !== 'object') {
        return {
          valid: false,
          errorCode: 'invalid_migration_definition',
          diagnostic: 'Migration entry at index ' + i + ' is not an object.'
        };
      }

      if (typeof m.version !== 'number' || !Number.isInteger(m.version) || m.version < 1) {
        return {
          valid: false,
          errorCode: 'invalid_migration_version',
          diagnostic: 'Migration entry at index ' + i + ' has an invalid version: must be a positive integer.'
        };
      }

      if (seenVersions[m.version]) {
        return {
          valid: false,
          errorCode: 'duplicate_migration_version',
          diagnostic: 'Duplicate migration version detected: ' + m.version + '.'
        };
      }
      seenVersions[m.version] = true;

      if (m.version <= prevVersion) {
        return {
          valid: false,
          errorCode: 'unordered_migration_versions',
          diagnostic: 'Migrations must be registered in strictly ascending version order (found ' + m.version + ' after ' + prevVersion + ').'
        };
      }
      prevVersion = m.version;

      if (!m.name || typeof m.name !== 'string' || !m.name.trim()) {
        return {
          valid: false,
          errorCode: 'invalid_migration_name',
          diagnostic: 'Migration version ' + m.version + ' is missing a valid name.'
        };
      }

      if (seenNames[m.name]) {
        return {
          valid: false,
          errorCode: 'duplicate_migration_name',
          diagnostic: 'Duplicate migration name detected: ' + m.name + '.'
        };
      }
      seenNames[m.name] = true;

      if (typeof m.up !== 'function') {
        return {
          valid: false,
          errorCode: 'invalid_migration_handler',
          diagnostic: 'Migration "' + m.name + '" is missing an up() execution function.'
        };
      }
    }

    return {
      valid: true,
      migrations: list.slice(),
      maxVersion: prevVersion
    };
  },

  /**
   * Selects pending migrations with version > currentVersion in ascending order.
   *
   * @param {number} currentVersion - Validated current schema version (0 if uninitialized).
   * @param {Array<Object>} [migrationsList] - Optional migration list.
   * @returns {{
   *   valid: boolean,
   *   pending?: Array<Object>,
   *   errorCode?: string,
   *   diagnostic?: string
   * }}
   */
  getPendingMigrations: function(currentVersion, migrationsList) {
    if (typeof currentVersion !== 'number' || !Number.isInteger(currentVersion) || currentVersion < 0) {
      return {
        valid: false,
        errorCode: 'invalid_schema_version',
        diagnostic: 'currentVersion must be a non-negative integer.'
      };
    }

    var regCheck = this.validateMigrationRegistry(migrationsList);
    if (!regCheck.valid) {
      return regCheck;
    }

    if (currentVersion > regCheck.maxVersion) {
      return {
        valid: false,
        errorCode: 'unsupported_future_schema_version',
        diagnostic: 'currentVersion (' + currentVersion + ') exceeds highest registered migration version (' + regCheck.maxVersion + ').'
      };
    }

    var pending = [];
    for (var i = 0; i < regCheck.migrations.length; i++) {
      if (regCheck.migrations[i].version > currentVersion) {
        pending.push(regCheck.migrations[i]);
      }
    }

    return {
      valid: true,
      pending: pending
    };
  },

  /**
   * Inspects an unversioned spreadsheet (SCHEMA_VERSION = 0) for pre-existing data rows (lastRow > 1).
   * Partial header-only worksheets from an interrupted initial migration (lastRow <= 1) are allowed
   * to resume safely, whereas existing data rows without a recorded schema version are flagged as
   * an ambiguous unversioned baseline.
   *
   * @param {Object} spreadsheet - Apps Script Spreadsheet object.
   * @returns {{
   *   isAmbiguous: boolean,
   *   populatedWorksheets: Array<{ name: string, rowCount: number }>,
   *   diagnostic?: string
   * }}
   */
  detectAmbiguousUnversionedData: function(spreadsheet) {
    var populated = [];
    if (!spreadsheet) {
      return { isAmbiguous: false, populatedWorksheets: [] };
    }

    var sheetsToInspect = [];
    if (typeof spreadsheet.getSheets === 'function') {
      sheetsToInspect = spreadsheet.getSheets() || [];
    } else if (typeof spreadsheet.getSheetByName === 'function') {
      var names = SchemaRegistry.getWorksheetNames();
      for (var n = 0; n < names.length; n++) {
        var s = spreadsheet.getSheetByName(names[n]);
        if (s) {
          sheetsToInspect.push(s);
        }
      }
    }

    for (var i = 0; i < sheetsToInspect.length; i++) {
      var sheet = sheetsToInspect[i];
      if (!sheet) continue;
      var lastRow = typeof sheet.getLastRow === 'function' ? sheet.getLastRow() : 0;
      if (lastRow > 1) {
        var sheetName = typeof sheet.getName === 'function' ? sheet.getName() : ('Sheet_' + (i + 1));
        populated.push({
          name: sheetName,
          rowCount: lastRow
        });
      }
    }

    if (populated.length > 0) {
      var summary = [];
      for (var j = 0; j < populated.length; j++) {
        summary.push(populated[j].name + ' (' + populated[j].rowCount + ' rows)');
      }
      return {
        isAmbiguous: true,
        populatedWorksheets: populated,
        diagnostic: 'Target spreadsheet contains existing data rows in [' + summary.join(', ') + '] but has no recorded SCHEMA_VERSION. Explicit baseline verification or adoption is required.'
      };
    }

    return {
      isAmbiguous: false,
      populatedWorksheets: []
    };
  },

  /**
   * Executes pending database schema migrations under LockService concurrency protection.
   *
   * Workflow:
   * 1. Validate SchemaRegistry integrity and MigrationRegistry ordering.
   * 2. Acquire LockService.getScriptLock(). Fail safely with 'migration_lock_timeout' if unavailable.
   * 3. Read and validate persisted SCHEMA_VERSION.
   * 4. Open target spreadsheet (or use options.spreadsheet in test harness).
   * 5. Guard against ambiguous unversioned pre-populated databases (unless options.adoptExistingBaseline === true).
   * 6. Execute pending migrations in ascending version order.
   * 7. Verify final schema against SchemaRegistry.
   * 8. Persist new SCHEMA_VERSION only after all steps and verification succeed.
   * 9. Always release script lock in finally block.
   *
   * @param {Object} [options] - Optional execution settings:
   *   - spreadsheet: Apps Script Spreadsheet instance (for disposable DEV / test harness).
   *   - properties: Script Properties store override.
   *   - migrations: Custom migration list override (for testing multi-version migrations).
   *   - maxSupportedVersion: Maximum version override (defaults to highest migration version or SchemaRegistry.CURRENT_VERSION).
   *   - adoptExistingBaseline: Boolean; if true, allows initial baseline migration on a spreadsheet that already contains valid canonical populated worksheets.
   *   - lockTimeoutMs: Lock timeout in ms (defaults to 10000).
   * @returns {{
   *   success: boolean,
   *   status?: string,
   *   previousVersion?: number,
   *   currentVersion?: number,
   *   appliedMigrations?: string[],
   *   worksheetResults?: Array<Object>,
   *   errorCode?: string,
   *   errorMessage?: string,
   *   diagnostic?: string
   * }}
   */
  runMigrations: function(options) {
    var opts = options || {};

    var registryIntegrity = SchemaRegistry.validateRegistryIntegrity();
    if (!registryIntegrity.valid) {
      return {
        success: false,
        errorCode: 'invalid_schema_registry',
        errorMessage: this.SAFE_ERROR_MESSAGE,
        diagnostic: registryIntegrity.errors.join('; ')
      };
    }

    var migrationsList = opts.migrations !== undefined ? opts.migrations : this.MIGRATIONS;
    var migrationRegCheck = this.validateMigrationRegistry(migrationsList);
    if (!migrationRegCheck.valid) {
      return {
        success: false,
        errorCode: migrationRegCheck.errorCode || 'invalid_migration_registry',
        errorMessage: this.SAFE_ERROR_MESSAGE,
        diagnostic: migrationRegCheck.diagnostic
      };
    }

    var maxSupportedVersion = (typeof opts.maxSupportedVersion === 'number' && Number.isInteger(opts.maxSupportedVersion))
      ? opts.maxSupportedVersion
      : Math.max(SchemaRegistry.getCurrentVersion(), migrationRegCheck.maxVersion);

    if (typeof LockService === 'undefined' || !LockService || typeof LockService.getScriptLock !== 'function') {
      return {
        success: false,
        errorCode: 'lock_service_unavailable',
        errorMessage: this.SAFE_ERROR_MESSAGE,
        diagnostic: 'LockService.getScriptLock() is unavailable.'
      };
    }

    var lock = LockService.getScriptLock();
    var hasLock = false;
    var lockTimeoutMs = (typeof opts.lockTimeoutMs === 'number' && opts.lockTimeoutMs >= 0)
      ? opts.lockTimeoutMs
      : this.DEFAULT_LOCK_TIMEOUT_MS;

    try {
      hasLock = lock.tryLock(lockTimeoutMs);
    } catch (_lockErr) {
      hasLock = false;
    }

    if (!hasLock) {
      return {
        success: false,
        errorCode: 'migration_lock_timeout',
        errorMessage: 'Could not acquire lock to execute database schema migrations.',
        diagnostic: 'LockService.tryLock(' + lockTimeoutMs + ') returned false.'
      };
    }

    try {
      // 1. Read and validate persisted SCHEMA_VERSION
      var versionCheck = this.getSchemaVersion(opts.properties, maxSupportedVersion);
      if (!versionCheck.valid) {
        return {
          success: false,
          errorCode: versionCheck.errorCode || 'invalid_schema_version',
          errorMessage: versionCheck.errorMessage || this.SAFE_ERROR_MESSAGE,
          diagnostic: versionCheck.diagnostic
        };
      }

      var currentVersion = versionCheck.version;

      // 2. Resolve target spreadsheet
      var spreadsheet = opts.spreadsheet;
      if (!spreadsheet) {
        var openRes = this.openConfiguredSpreadsheet(opts.properties);
        if (!openRes.success) {
          return {
            success: false,
            previousVersion: currentVersion,
            currentVersion: currentVersion,
            errorCode: openRes.errorCode || 'spreadsheet_open_failed',
            errorMessage: openRes.errorMessage || this.SAFE_ERROR_MESSAGE
          };
        }
        spreadsheet = openRes.spreadsheet;
      }

      // 3. Detect ambiguous unversioned pre-populated spreadsheet
      if (currentVersion === 0 && opts.adoptExistingBaseline !== true) {
        var ambiguity = this.detectAmbiguousUnversionedData(spreadsheet);
        if (ambiguity.isAmbiguous) {
          return {
            success: false,
            previousVersion: 0,
            currentVersion: 0,
            errorCode: 'ambiguous_unversioned_database',
            errorMessage: 'Target spreadsheet contains existing data but has no schema version.',
            diagnostic: ambiguity.diagnostic
          };
        }
      }

      // 4. Determine pending migrations
      var pendingCheck = this.getPendingMigrations(currentVersion, migrationsList);
      if (!pendingCheck.valid) {
        return {
          success: false,
          previousVersion: currentVersion,
          currentVersion: currentVersion,
          errorCode: pendingCheck.errorCode || 'migration_selection_failed',
          errorMessage: this.SAFE_ERROR_MESSAGE,
          diagnostic: pendingCheck.diagnostic
        };
      }

      var pending = pendingCheck.pending;

      // If no migrations are pending, still validate current schema integrity
      if (pending.length === 0) {
        var currentSchemaCheck = this.validateDatabaseSchema(spreadsheet);
        if (!currentSchemaCheck.valid) {
          var firstErr = currentSchemaCheck.errors[0];
          return {
            success: false,
            previousVersion: currentVersion,
            currentVersion: currentVersion,
            errorCode: (firstErr && firstErr.errorCode) ? firstErr.errorCode : 'schema_validation_failed',
            errorMessage: 'Existing database schema failed verification.',
            diagnostic: currentSchemaCheck.diagnostic
          };
        }

        return {
          success: true,
          status: 'up_to_date',
          previousVersion: currentVersion,
          currentVersion: currentVersion,
          appliedMigrations: [],
          worksheetResults: []
        };
      }

      // 5. Execute pending migrations sequentially in ascending order
      var appliedMigrations = [];
      var latestWorksheetResults = [];
      var targetVersion = currentVersion;

      for (var i = 0; i < pending.length; i++) {
        var migration = pending[i];
        var stepResult;
        try {
          stepResult = migration.up(spreadsheet, {
            previousVersion: currentVersion,
            targetVersion: migration.version
          });
        } catch (stepErr) {
          return {
            success: false,
            previousVersion: currentVersion,
            currentVersion: currentVersion,
            errorCode: 'migration_execution_failed',
            errorMessage: 'Database schema migration failed during execution.',
            diagnostic: 'Migration "' + migration.name + '" threw error: ' + (stepErr && stepErr.message ? stepErr.message : String(stepErr))
          };
        }

        if (!stepResult || stepResult.success !== true) {
          return {
            success: false,
            previousVersion: currentVersion,
            currentVersion: currentVersion,
            errorCode: (stepResult && stepResult.errorCode) ? stepResult.errorCode : 'migration_execution_failed',
            errorMessage: 'Database schema migration failed.',
            diagnostic: (stepResult && stepResult.diagnostic)
              ? stepResult.diagnostic
              : ('Migration "' + migration.name + '" returned unsuccessful status.'),
            worksheetResults: (stepResult && stepResult.worksheetResults) ? stepResult.worksheetResults : []
          };
        }

        if (Array.isArray(stepResult.worksheetResults)) {
          latestWorksheetResults = stepResult.worksheetResults;
        }

        if (typeof migration.isApplied === 'function') {
          var appliedOk = false;
          try {
            appliedOk = migration.isApplied(spreadsheet) === true;
          } catch (_verifyErr) {
            appliedOk = false;
          }
          if (!appliedOk) {
            return {
              success: false,
              previousVersion: currentVersion,
              currentVersion: currentVersion,
              errorCode: 'migration_verification_failed',
              errorMessage: 'Database schema migration verification failed.',
              diagnostic: 'Post-migration check isApplied() returned false for "' + migration.name + '".'
            };
          }
        }

        appliedMigrations.push(migration.name);
        targetVersion = migration.version;
      }

      // 6. Final canonical schema verification before persisting version
      var finalValidation = this.validateDatabaseSchema(spreadsheet);
      if (!finalValidation.valid) {
        var firstFinalErr = finalValidation.errors[0];
        return {
          success: false,
          previousVersion: currentVersion,
          currentVersion: currentVersion,
          errorCode: (firstFinalErr && firstFinalErr.errorCode) ? firstFinalErr.errorCode : 'schema_validation_failed',
          errorMessage: 'Post-migration schema verification failed.',
          diagnostic: finalValidation.diagnostic
        };
      }

      // 7. Persist new schema version ONLY after all migrations and verification succeed
      var persistRes = this.setSchemaVersion(targetVersion, currentVersion, opts.properties, maxSupportedVersion);
      if (!persistRes.success) {
        return {
          success: false,
          previousVersion: currentVersion,
          currentVersion: currentVersion,
          errorCode: persistRes.errorCode || 'version_persistence_failed',
          errorMessage: persistRes.errorMessage || 'Failed to persist updated schema version.'
        };
      }

      return {
        success: true,
        status: 'migrated',
        previousVersion: currentVersion,
        currentVersion: targetVersion,
        appliedMigrations: appliedMigrations,
        worksheetResults: latestWorksheetResults
      };
    } finally {
      try {
        lock.releaseLock();
      } catch (_releaseErr) {
        // Safe cleanup if lock already released
      }
    }
  }
};
