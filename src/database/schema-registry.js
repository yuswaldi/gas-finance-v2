/**
 * SchemaRegistry module (FFM-013)
 * Single authoritative source of truth for the Google Sheets database schema
 * of Personal & Family Finance Manager (FFM).
 *
 * Mirrors database-schema.md strictly:
 * - 29 canonical worksheets in deterministic order.
 * - Exact column names and header ordering.
 * - Primary key and household-scoping metadata.
 * - Documented enum/status constraints.
 * - Deeply frozen definitions to prevent runtime mutation by consumers.
 */
var SchemaRegistry = (function() {
  var CURRENT_VERSION = 1;

  var RAW_DEFINITIONS = [
    {
      order: 1,
      name: 'USERS',
      primaryKey: 'user_id',
      householdScoped: false,
      headers: [
        'user_id',
        'google_sub',
        'email',
        'email_verified',
        'full_name',
        'photo_url',
        'status',
        'last_login_at',
        'created_at',
        'updated_at'
      ],
      enums: {
        status: ['ACTIVE', 'DISABLED']
      }
    },
    {
      order: 2,
      name: 'HOUSEHOLD_MEMBERS',
      primaryKey: 'membership_id',
      householdScoped: true,
      headers: [
        'membership_id',
        'household_id',
        'user_id',
        'role',
        'status',
        'joined_at',
        'created_at',
        'updated_at'
      ],
      enums: {
        role: ['OWNER', 'PARTNER'],
        status: ['ACTIVE', 'INVITED', 'SUSPENDED', 'LEFT']
      }
    },
    {
      order: 3,
      name: 'ACCOUNTS',
      primaryKey: 'account_id',
      householdScoped: true,
      headers: [
        'account_id',
        'household_id',
        'account_name',
        'account_type',
        'bank_name',
        'account_number_masked',
        'owner_user_id',
        'ownership_type',
        'opening_balance',
        'opening_date',
        'is_active',
        'created_by',
        'updated_by',
        'created_at',
        'updated_at'
      ],
      enums: {
        account_type: ['BANK', 'EWALLET', 'CASH', 'SAVINGS', 'DEPOSIT', 'INVESTMENT', 'OTHER'],
        ownership_type: ['SHARED', 'PERSONAL']
      }
    },
    {
      order: 4,
      name: 'CATEGORIES',
      primaryKey: 'category_id',
      householdScoped: true,
      headers: [
        'category_id',
        'household_id',
        'parent_id',
        'category_name',
        'category_type',
        'icon',
        'color',
        'is_active',
        'created_by',
        'updated_by',
        'created_at',
        'updated_at'
      ],
      enums: {
        category_type: ['INCOME', 'EXPENSE']
      }
    },
    {
      order: 5,
      name: 'TRANSACTIONS',
      primaryKey: 'transaction_id',
      householdScoped: true,
      headers: [
        'transaction_id',
        'household_id',
        'transaction_number',
        'transaction_type',
        'transaction_date',
        'description',
        'total_amount',
        'status',
        'notes',
        'created_by',
        'updated_by',
        'posted_at',
        'voided_at',
        'created_at',
        'updated_at'
      ],
      enums: {
        transaction_type: ['INCOME', 'EXPENSE', 'TRANSFER', 'OPENING', 'ADJUSTMENT', 'DEBT_PAYMENT', 'INVESTMENT'],
        status: ['DRAFT', 'POSTED', 'VOID']
      }
    },
    {
      order: 6,
      name: 'TRANSACTION_ENTRIES',
      primaryKey: 'entry_id',
      householdScoped: true,
      headers: [
        'entry_id',
        'household_id',
        'transaction_id',
        'account_id',
        'category_id',
        'entry_type',
        'amount',
        'description',
        'created_at'
      ],
      enums: {
        entry_type: ['IN', 'OUT']
      }
    },
    {
      order: 7,
      name: 'TRANSACTION_TAGS',
      primaryKey: 'transaction_tag_id',
      householdScoped: true,
      headers: [
        'transaction_tag_id',
        'household_id',
        'transaction_id',
        'tag_name',
        'created_at'
      ],
      enums: {}
    },
    {
      order: 8,
      name: 'BUDGETS',
      primaryKey: 'budget_id',
      householdScoped: true,
      headers: [
        'budget_id',
        'household_id',
        'budget_name',
        'period_type',
        'start_date',
        'end_date',
        'rollover_enabled',
        'status',
        'created_by',
        'updated_by',
        'created_at',
        'updated_at'
      ],
      enums: {
        period_type: ['MONTHLY', 'YEARLY', 'CUSTOM'],
        status: ['ACTIVE', 'ARCHIVED']
      }
    },
    {
      order: 9,
      name: 'BUDGET_ITEMS',
      primaryKey: 'budget_item_id',
      householdScoped: true,
      headers: [
        'budget_item_id',
        'household_id',
        'budget_id',
        'category_id',
        'allocated_amount',
        'rollover_amount',
        'alert_percentage',
        'created_at',
        'updated_at'
      ],
      enums: {}
    },
    {
      order: 10,
      name: 'RECURRING_RULES',
      primaryKey: 'recurring_id',
      householdScoped: true,
      headers: [
        'recurring_id',
        'household_id',
        'title',
        'transaction_type',
        'amount',
        'frequency',
        'interval_value',
        'start_date',
        'end_date',
        'next_run_date',
        'account_id',
        'category_id',
        'is_active',
        'created_by',
        'updated_by',
        'created_at',
        'updated_at'
      ],
      enums: {}
    },
    {
      order: 11,
      name: 'BILLS',
      primaryKey: 'bill_id',
      householdScoped: true,
      headers: [
        'bill_id',
        'household_id',
        'title',
        'category_id',
        'expected_amount',
        'due_date',
        'recurring_id',
        'status',
        'created_at',
        'updated_at'
      ],
      enums: {}
    },
    {
      order: 12,
      name: 'BILL_PAYMENTS',
      primaryKey: 'payment_id',
      householdScoped: true,
      headers: [
        'payment_id',
        'household_id',
        'bill_id',
        'transaction_id',
        'paid_amount',
        'paid_date',
        'created_at',
        'created_by'
      ],
      enums: {}
    },
    {
      order: 13,
      name: 'SAVINGS_GOALS',
      primaryKey: 'goal_id',
      householdScoped: true,
      headers: [
        'goal_id',
        'household_id',
        'goal_name',
        'target_amount',
        'target_date',
        'linked_account_id',
        'status',
        'created_at',
        'updated_at'
      ],
      enums: {}
    },
    {
      order: 14,
      name: 'GOAL_CONTRIBUTIONS',
      primaryKey: 'contribution_id',
      householdScoped: true,
      headers: [
        'contribution_id',
        'household_id',
        'goal_id',
        'transaction_id',
        'amount',
        'contribution_date',
        'created_at',
        'created_by'
      ],
      enums: {}
    },
    {
      order: 15,
      name: 'LIABILITIES',
      primaryKey: 'liability_id',
      householdScoped: true,
      headers: [
        'liability_id',
        'household_id',
        'lender_name',
        'debt_name',
        'principal_amount',
        'outstanding_amount',
        'interest_rate',
        'installment_amount',
        'maturity_date',
        'status',
        'created_at',
        'updated_at'
      ],
      enums: {}
    },
    {
      order: 16,
      name: 'DEBT_PAYMENTS',
      primaryKey: 'payment_id',
      householdScoped: true,
      headers: [
        'payment_id',
        'household_id',
        'liability_id',
        'transaction_id',
        'principal_paid',
        'interest_paid',
        'fee_paid',
        'payment_date',
        'created_at',
        'created_by'
      ],
      enums: {}
    },
    {
      order: 17,
      name: 'ASSETS',
      primaryKey: 'asset_id',
      householdScoped: true,
      headers: [
        'asset_id',
        'household_id',
        'asset_name',
        'asset_type',
        'ownership_type',
        'purchase_date',
        'purchase_price',
        'current_value',
        'status',
        'created_at',
        'updated_at'
      ],
      enums: {}
    },
    {
      order: 18,
      name: 'ASSET_VALUATIONS',
      primaryKey: 'valuation_id',
      householdScoped: true,
      headers: [
        'valuation_id',
        'household_id',
        'asset_id',
        'valuation_date',
        'market_value',
        'valuation_source',
        'created_by',
        'created_at'
      ],
      enums: {}
    },
    {
      order: 19,
      name: 'INVESTMENTS',
      primaryKey: 'investment_id',
      householdScoped: true,
      headers: [
        'investment_id',
        'household_id',
        'investment_name',
        'investment_type',
        'account_id',
        'units',
        'average_cost',
        'current_price',
        'current_value',
        'status',
        'created_at',
        'updated_at'
      ],
      enums: {}
    },
    {
      order: 20,
      name: 'INVESTMENT_TRANSACTIONS',
      primaryKey: 'investment_transaction_id',
      householdScoped: true,
      headers: [
        'investment_transaction_id',
        'household_id',
        'investment_id',
        'transaction_type',
        'transaction_date',
        'quantity',
        'unit_price',
        'fee',
        'total_amount',
        'transaction_id',
        'created_at',
        'created_by'
      ],
      enums: {}
    },
    {
      order: 21,
      name: 'ATTACHMENTS',
      primaryKey: 'attachment_id',
      householdScoped: true,
      headers: [
        'attachment_id',
        'household_id',
        'transaction_id',
        'drive_file_id',
        'original_filename',
        'mime_type',
        'file_size',
        'uploaded_by',
        'created_at',
        'status'
      ],
      enums: {}
    },
    {
      order: 22,
      name: 'NOTIFICATIONS',
      primaryKey: 'notification_id',
      householdScoped: true,
      headers: [
        'notification_id',
        'household_id',
        'user_id',
        'notification_type',
        'title',
        'message',
        'reference_type',
        'reference_id',
        'scheduled_at',
        'read_at',
        'status',
        'created_at'
      ],
      enums: {}
    },
    {
      order: 23,
      name: 'AUDIT_LOGS',
      primaryKey: 'log_id',
      householdScoped: true,
      headers: [
        'log_id',
        'household_id',
        'user_id',
        'action',
        'entity_type',
        'entity_id',
        'old_values_json',
        'new_values_json',
        'correlation_id',
        'created_at'
      ],
      enums: {}
    },
    {
      order: 24,
      name: 'SYSTEM_SETTINGS',
      primaryKey: 'setting_key',
      householdScoped: false,
      headers: [
        'setting_key',
        'setting_value',
        'description',
        'updated_by',
        'updated_at'
      ],
      enums: {}
    },
    {
      order: 25,
      name: 'JOB_LOGS',
      primaryKey: 'job_id',
      householdScoped: false,
      headers: [
        'job_id',
        'job_type',
        'started_at',
        'completed_at',
        'status',
        'records_processed',
        'error_code',
        'error_message',
        'correlation_id'
      ],
      enums: {}
    },
    {
      order: 26,
      name: 'USER_SESSIONS',
      primaryKey: 'session_id',
      householdScoped: false,
      headers: [
        'session_id',
        'user_id',
        'token_hash',
        'created_at',
        'last_seen_at',
        'expires_at',
        'revoked_at',
        'status',
        'user_agent_hash'
      ],
      enums: {
        status: ['ACTIVE', 'REVOKED', 'EXPIRED']
      }
    },
    {
      order: 27,
      name: 'TRANSACTION_OPERATIONS',
      primaryKey: 'operation_id',
      householdScoped: true,
      headers: [
        'operation_id',
        'household_id',
        'transaction_id',
        'idempotency_key',
        'operation_type',
        'operation_status',
        'started_at',
        'completed_at',
        'error_message',
        'recovery_attempts'
      ],
      enums: {
        operation_status: ['PENDING', 'COMMITTED', 'FAILED', 'NEEDS_REVIEW']
      }
    },
    {
      order: 28,
      name: 'LOGIN_NONCES',
      primaryKey: 'nonce_id',
      householdScoped: false,
      headers: [
        'nonce_id',
        'nonce_hash',
        'created_at',
        'expires_at',
        'consumed_at',
        'status'
      ],
      enums: {}
    },
    {
      order: 29,
      name: 'LOGIN_LOGS',
      primaryKey: 'login_log_id',
      householdScoped: false,
      headers: [
        'login_log_id',
        'user_id',
        'email_snapshot',
        'event_type',
        'result',
        'reason_code',
        'occurred_at',
        'correlation_id'
      ],
      enums: {}
    }
  ];

  // Freeze all definitions and build lookup map
  var WORKSHEET_NAMES = [];
  var WORKSHEETS_BY_NAME = {};
  var FROZEN_DEFINITIONS = [];

  for (var i = 0; i < RAW_DEFINITIONS.length; i++) {
    var def = RAW_DEFINITIONS[i];
    var frozenEnums = {};
    var enumKeys = Object.keys(def.enums || {});
    for (var k = 0; k < enumKeys.length; k++) {
      var ek = enumKeys[k];
      frozenEnums[ek] = Object.freeze(def.enums[ek].slice());
    }

    var frozenDef = Object.freeze({
      order: def.order,
      name: def.name,
      primaryKey: def.primaryKey,
      householdScoped: def.householdScoped,
      headers: Object.freeze(def.headers.slice()),
      enums: Object.freeze(frozenEnums)
    });

    WORKSHEET_NAMES.push(def.name);
    WORKSHEETS_BY_NAME[def.name] = frozenDef;
    FROZEN_DEFINITIONS.push(frozenDef);
  }

  Object.freeze(WORKSHEET_NAMES);
  Object.freeze(WORKSHEETS_BY_NAME);
  Object.freeze(FROZEN_DEFINITIONS);

  return Object.freeze({
    /**
     * Authoritative current schema version supported by the codebase.
     */
    CURRENT_VERSION: CURRENT_VERSION,

    /**
     * Frozen array of all 29 canonical worksheet names in order.
     */
    WORKSHEET_NAMES: WORKSHEET_NAMES,

    /**
     * Frozen map of worksheet name to frozen worksheet definition.
     */
    WORKSHEETS: WORKSHEETS_BY_NAME,

    /**
     * Returns the current canonical schema version integer.
     *
     * @returns {number}
     */
    getCurrentVersion: function() {
      return CURRENT_VERSION;
    },

    /**
     * Returns a copy of the ordered canonical worksheet names.
     *
     * @returns {string[]}
     */
    getWorksheetNames: function() {
      return WORKSHEET_NAMES.slice();
    },

    /**
     * Returns all frozen worksheet definitions in canonical order.
     *
     * @returns {Array<Object>}
     */
    getAllWorksheetDefinitions: function() {
      return FROZEN_DEFINITIONS.slice();
    },

    /**
     * Retrieves the frozen worksheet definition for a given worksheet name.
     *
     * @param {string} sheetName
     * @returns {Object|null}
     */
    getWorksheetDefinition: function(sheetName) {
      if (!sheetName || typeof sheetName !== 'string') {
        return null;
      }
      var trimmed = sheetName.trim();
      if (!Object.prototype.hasOwnProperty.call(WORKSHEETS_BY_NAME, trimmed)) {
        return null;
      }
      return WORKSHEETS_BY_NAME[trimmed];
    },

    /**
     * Returns a copy of the ordered canonical header array for a worksheet.
     *
     * @param {string} sheetName
     * @returns {string[]|null}
     */
    getHeaders: function(sheetName) {
      var def = this.getWorksheetDefinition(sheetName);
      if (!def) {
        return null;
      }
      return def.headers.slice();
    },

    /**
     * Validates internal integrity of the schema registry:
     * - Positive integer CURRENT_VERSION.
     * - No duplicate worksheet names.
     * - No duplicate or empty headers within any worksheet.
     * - Primary key present as first column.
     * - Household scoping matches presence of 'household_id'.
     *
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validateRegistryIntegrity: function() {
      var errors = [];
      if (typeof CURRENT_VERSION !== 'number' || !Number.isInteger(CURRENT_VERSION) || CURRENT_VERSION < 1) {
        errors.push('Invalid CURRENT_VERSION: must be a positive integer.');
      }

      var seenSheetNames = {};
      for (var i = 0; i < FROZEN_DEFINITIONS.length; i++) {
        var def = FROZEN_DEFINITIONS[i];
        if (!def.name || typeof def.name !== 'string') {
          errors.push('Worksheet at index ' + i + ' has an invalid name.');
          continue;
        }
        if (seenSheetNames[def.name]) {
          errors.push('Duplicate worksheet name in registry: ' + def.name);
        }
        seenSheetNames[def.name] = true;

        if (!Array.isArray(def.headers) || def.headers.length === 0) {
          errors.push('Worksheet ' + def.name + ' has no headers.');
          continue;
        }

        var seenHeaders = {};
        for (var j = 0; j < def.headers.length; j++) {
          var h = def.headers[j];
          if (!h || typeof h !== 'string' || h.trim() !== h) {
            errors.push('Worksheet ' + def.name + ' has an invalid header at column ' + (j + 1));
          }
          if (seenHeaders[h]) {
            errors.push('Duplicate header "' + h + '" in worksheet ' + def.name);
          }
          seenHeaders[h] = true;
        }

        if (def.headers[0] !== def.primaryKey) {
          errors.push('Worksheet ' + def.name + ' primaryKey "' + def.primaryKey + '" does not match first column "' + def.headers[0] + '".');
        }

        var hasHouseholdCol = def.headers.indexOf('household_id') !== -1;
        if (def.householdScoped && !hasHouseholdCol) {
          errors.push('Household-scoped worksheet ' + def.name + ' is missing household_id column.');
        }
        if (!def.householdScoped && hasHouseholdCol) {
          errors.push('Non-household-scoped worksheet ' + def.name + ' unexpectedly contains household_id column.');
        }
      }

      return {
        valid: errors.length === 0,
        errors: errors
      };
    },

    /**
     * Validates an actual worksheet header row against the canonical schema definition.
     * Detects missing columns, unknown/extra columns, renamed columns, and reordered columns.
     * Never modifies or truncates unknown columns.
     *
     * @param {string} sheetName - Canonical worksheet name.
     * @param {Array<*>} actualHeaders - Row 1 values read from the worksheet.
     * @returns {{
     *   valid: boolean,
     *   isEmpty: boolean,
     *   worksheet: string,
     *   errorCode?: string,
     *   expectedHeaders?: string[],
     *   actualHeaders?: string[],
     *   missingColumns?: string[],
     *   unknownColumns?: string[],
     *   orderMismatches?: Array<{ index: number, expected: string, actual: string }>,
     *   diagnostic?: string
     * }}
     */
    validateWorksheetHeaders: function(sheetName, actualHeaders) {
      var def = this.getWorksheetDefinition(sheetName);
      if (!def) {
        return {
          valid: false,
          isEmpty: false,
          worksheet: String(sheetName || ''),
          errorCode: 'unknown_worksheet',
          diagnostic: 'Worksheet "' + String(sheetName || '') + '" is not defined in the canonical schema registry.'
        };
      }

      if (!Array.isArray(actualHeaders) || actualHeaders.length === 0) {
        return {
          valid: false,
          isEmpty: true,
          worksheet: def.name,
          errorCode: 'empty_headers',
          expectedHeaders: def.headers.slice(),
          actualHeaders: [],
          diagnostic: 'Worksheet "' + def.name + '" has an empty header row.'
        };
      }

      var normalizedActual = [];
      var hasAnyNonEmptyCell = false;
      for (var i = 0; i < actualHeaders.length; i++) {
        var rawCell = actualHeaders[i];
        var strCell = (rawCell !== null && rawCell !== undefined) ? String(rawCell).trim() : '';
        if (strCell !== '') {
          hasAnyNonEmptyCell = true;
        }
        normalizedActual.push(strCell);
      }

      if (!hasAnyNonEmptyCell) {
        return {
          valid: false,
          isEmpty: true,
          worksheet: def.name,
          errorCode: 'empty_headers',
          expectedHeaders: def.headers.slice(),
          actualHeaders: [],
          diagnostic: 'Worksheet "' + def.name + '" has an empty header row.'
        };
      }

      var expected = def.headers;
      var missingColumns = [];
      var unknownColumns = [];
      var orderMismatches = [];

      for (var eIdx = 0; eIdx < expected.length; eIdx++) {
        if (normalizedActual.indexOf(expected[eIdx]) === -1) {
          missingColumns.push(expected[eIdx]);
        }
      }

      for (var aIdx = 0; aIdx < normalizedActual.length; aIdx++) {
        var colName = normalizedActual[aIdx];
        if (colName === '') {
          unknownColumns.push('(empty_column_' + (aIdx + 1) + ')');
        } else if (expected.indexOf(colName) === -1) {
          unknownColumns.push(colName);
        }
      }

      var maxLen = Math.max(expected.length, normalizedActual.length);
      for (var idx = 0; idx < maxLen; idx++) {
        var expVal = idx < expected.length ? expected[idx] : '(none)';
        var actVal = idx < normalizedActual.length ? (normalizedActual[idx] || '(empty)') : '(missing)';
        if (expVal !== actVal) {
          orderMismatches.push({
            index: idx,
            columnNumber: idx + 1,
            expected: expVal,
            actual: actVal
          });
        }
      }

      if (missingColumns.length > 0 || unknownColumns.length > 0 || orderMismatches.length > 0) {
        var diagParts = [];
        if (missingColumns.length > 0) {
          diagParts.push('missing columns [' + missingColumns.join(', ') + ']');
        }
        if (unknownColumns.length > 0) {
          diagParts.push('unknown columns [' + unknownColumns.join(', ') + ']');
        }
        if (orderMismatches.length > 0) {
          var firstMismatch = orderMismatches[0];
          diagParts.push(
            'column ' + firstMismatch.columnNumber +
            ' expected "' + firstMismatch.expected +
            '" but found "' + firstMismatch.actual + '"'
          );
        }

        return {
          valid: false,
          isEmpty: false,
          worksheet: def.name,
          errorCode: 'header_mismatch',
          expectedHeaders: expected.slice(),
          actualHeaders: normalizedActual,
          missingColumns: missingColumns,
          unknownColumns: unknownColumns,
          orderMismatches: orderMismatches,
          diagnostic: 'Header mismatch in worksheet "' + def.name + '": ' + diagParts.join('; ') + '.'
        };
      }

      return {
        valid: true,
        isEmpty: false,
        worksheet: def.name,
        expectedHeaders: expected.slice(),
        actualHeaders: normalizedActual
      };
    }
  });
})();
