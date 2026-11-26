/**
 * AuthAuthorization module (FFM-012)
 * Implements server-side household membership resolution, role-based access control (RBAC),
 * and household data isolation for Personal & Family Finance Manager.
 *
 * Enforces the authorization boundary between an authenticated FFM-010/011 application session
 * and household data or operations.
 *
 * Household model:
 * - Single shared household per deployment environment (one spreadsheet per household).
 * - Two registered roles defined by PRD and database schema: OWNER and PARTNER.
 * - Default-deny authorization policy: every protected operation must be explicitly permitted.
 * - Never trusts browser-supplied user_id, email, google_sub, role, isOwner, household_id, or spreadsheet_id.
 */
var AuthAuthorization = {
  /**
   * Valid household roles defined in PRD Section 4, Architecture Section 4.1, and Database Schema Section 3.
   */
  VALID_ROLES: ['OWNER', 'PARTNER'],

  /**
   * Shared household and finance permissions granted to both OWNER and PARTNER.
   * All transactions and financial records are shared within the single household.
   */
  SHARED_PERMISSIONS: [
    'household.view',
    'dashboard.view',
    'account.view',
    'account.create',
    'account.update',
    'account.deactivate',
    'category.view',
    'category.create',
    'category.update',
    'category.deactivate',
    'transaction.view',
    'transaction.create',
    'transaction.update',
    'transaction.post',
    'transaction.void',
    'budget.view',
    'budget.create',
    'budget.update',
    'budget.archive',
    'bill.view',
    'bill.create',
    'bill.update',
    'bill.pay',
    'savings.view',
    'savings.create',
    'savings.update',
    'savings.contribute',
    'liability.view',
    'liability.create',
    'liability.update',
    'liability.pay',
    'asset.view',
    'asset.create',
    'asset.update',
    'asset.valuate',
    'investment.view',
    'investment.create',
    'investment.update',
    'investment.trade',
    'attachment.view',
    'attachment.upload',
    'attachment.delete',
    'report.view',
    'report.export',
    'notification.view',
    'notification.update',
    'session.revoke_own'
  ],

  /**
   * Administrative and owner-level security permissions granted exclusively to OWNER.
   */
  OWNER_ONLY_PERMISSIONS: [
    'household.settings.manage',
    'household.member.manage',
    'security.settings.manage',
    'session.revoke_any',
    'system.backup.manage',
    'audit.view'
  ],

  /**
   * Generic safe error message for unauthorized operations.
   * Never leaks private emails, household configuration, spreadsheet IDs, or role internals.
   */
  SAFE_ERROR_MESSAGE: 'You are not authorized to perform this operation.',

  /**
   * Generic safe error message for unauthenticated requests.
   */
  SAFE_UNAUTHENTICATED_MESSAGE: 'Authentication is required to perform this operation. Please sign in.',

  /**
   * Validates household identifier format (1 to 128 alphanumeric, hyphen, or underscore characters).
   *
   * @param {*} householdId
   * @returns {boolean}
   */
  isValidHouseholdIdFormat: function(householdId) {
    if (typeof householdId !== 'string') {
      return false;
    }
    var trimmed = householdId.trim();
    if (trimmed.length === 0 || trimmed.length > 128) {
      return false;
    }
    return /^[a-zA-Z0-9_-]+$/.test(trimmed);
  },

  /**
   * Validates basic email format (non-empty string containing '@' not at boundaries and no whitespace).
   *
   * @param {*} email
   * @returns {boolean}
   */
  isValidEmailFormat: function(email) {
    if (typeof email !== 'string') {
      return false;
    }
    var trimmed = email.trim().toLowerCase();
    if (!trimmed || trimmed.indexOf(' ') !== -1) {
      return false;
    }
    var atIndex = trimmed.indexOf('@');
    return atIndex > 0 && atIndex < trimmed.length - 1;
  },

  /**
   * Returns the complete array of permissions granted to a valid role.
   * Returns an empty array for unknown or invalid roles (default deny).
   *
   * @param {string} role
   * @returns {string[]}
   */
  getPermissionsForRole: function(role) {
    if (typeof role !== 'string') {
      return [];
    }
    if (role === 'OWNER') {
      return this.SHARED_PERMISSIONS.concat(this.OWNER_ONLY_PERMISSIONS);
    }
    if (role === 'PARTNER') {
      return this.SHARED_PERMISSIONS.slice();
    }
    return [];
  },

  /**
   * Checks whether a given role is valid ('OWNER' or 'PARTNER').
   *
   * @param {*} role
   * @returns {boolean}
   */
  isValidRole: function(role) {
    if (typeof role !== 'string') {
      return false;
    }
    return this.VALID_ROLES.indexOf(role) !== -1;
  },

  /**
   * Evaluates whether a given role grants the requested permission.
   * Denies by default if role is missing/unknown or permission is missing/unlisted.
   *
   * @param {string} role - Resolved server-side role.
   * @param {string} permission - Requested permission identifier.
   * @returns {{
   *   permitted: boolean,
   *   errorCode?: string,
   *   errorMessage?: string
   * }}
   */
  evaluateRolePermission: function(role, permission) {
    if (!role || typeof role !== 'string' || role.trim().length === 0) {
      return {
        permitted: false,
        errorCode: 'role_not_found',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    if (!this.isValidRole(role)) {
      return {
        permitted: false,
        errorCode: 'role_not_found',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    if (!permission || typeof permission !== 'string' || permission.trim().length === 0) {
      return {
        permitted: false,
        errorCode: 'permission_denied',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    var grantedPermissions = this.getPermissionsForRole(role);
    if (grantedPermissions.indexOf(permission.trim()) === -1) {
      return {
        permitted: false,
        errorCode: 'permission_denied',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    return { permitted: true };
  },

  /**
   * Loads and validates household and membership configuration from server-side Script Properties.
   * Fails closed if configuration is missing, empty, or malformed.
   * Never uses ALLOWED_EMAILS as a substitute for household membership configuration.
   *
   * Supported Script Properties:
   * 1. HOUSEHOLD_ID (required unless provided in HOUSEHOLD_CONFIG_JSON)
   * 2. HOUSEHOLD_NAME (optional, defaults to 'Personal & Family Household')
   * 3. HOUSEHOLD_STATUS (optional, defaults to 'ACTIVE')
   * 4. HOUSEHOLD_MEMBERS_JSON (JSON array of member records matching USERS + HOUSEHOLD_MEMBERS schema)
   *    OR flat member properties:
   *    - OWNER_EMAIL / OWNER_GOOGLE_SUB (with optional OWNER_USER_ID, OWNER_ROLE, OWNER_STATUS, OWNER_HOUSEHOLD_ID)
   *    - PARTNER_EMAIL / PARTNER_GOOGLE_SUB (with optional PARTNER_USER_ID, PARTNER_ROLE, PARTNER_STATUS, PARTNER_HOUSEHOLD_ID)
   *
   * @returns {{
   *   valid: boolean,
   *   errorCode?: string,
   *   errorMessage?: string,
   *   household?: {
   *     householdId: string,
   *     householdName: string,
   *     baseCurrency: string,
   *     timezone: string,
   *     status: string
   *   },
   *   members?: Array<Object>
   * }}
   */
  getHouseholdConfig: function() {
    var props;
    try {
      props = PropertiesService.getScriptProperties();
    } catch (err) {
      Logger.log('Security Warning: Unable to access Script Properties for household authorization.');
      return {
        valid: false,
        errorCode: 'authorization_configuration_error',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    if (!props) {
      return {
        valid: false,
        errorCode: 'authorization_configuration_error',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    var rawConfigJson = props.getProperty('HOUSEHOLD_CONFIG_JSON');
    var parsedConfig = null;
    if (rawConfigJson !== null && rawConfigJson !== undefined && String(rawConfigJson).trim() !== '') {
      try {
        parsedConfig = JSON.parse(String(rawConfigJson));
      } catch (_parseErr) {
        Logger.log('Security Warning: Malformed HOUSEHOLD_CONFIG_JSON in Script Properties.');
        return {
          valid: false,
          errorCode: 'authorization_configuration_error',
          errorMessage: this.SAFE_ERROR_MESSAGE
        };
      }
      if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
        return {
          valid: false,
          errorCode: 'authorization_configuration_error',
          errorMessage: this.SAFE_ERROR_MESSAGE
        };
      }
    }

    var rawHouseholdId = props.getProperty('HOUSEHOLD_ID');
    if ((rawHouseholdId === null || rawHouseholdId === undefined || String(rawHouseholdId).trim() === '') && parsedConfig) {
      rawHouseholdId = parsedConfig.householdId !== undefined ? parsedConfig.householdId : parsedConfig.household_id;
    }

    if (rawHouseholdId === null || rawHouseholdId === undefined) {
      return {
        valid: false,
        errorCode: 'authorization_configuration_error',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    var householdId = String(rawHouseholdId).trim();
    if (!householdId) {
      return {
        valid: false,
        errorCode: 'household_not_found',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    if (!this.isValidHouseholdIdFormat(householdId)) {
      return {
        valid: false,
        errorCode: 'authorization_configuration_error',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    var rawHouseholdStatus = props.getProperty('HOUSEHOLD_STATUS');
    if ((rawHouseholdStatus === null || rawHouseholdStatus === undefined || String(rawHouseholdStatus).trim() === '') && parsedConfig && parsedConfig.status !== undefined) {
      rawHouseholdStatus = parsedConfig.status;
    }
    var householdStatus = (rawHouseholdStatus !== null && rawHouseholdStatus !== undefined && String(rawHouseholdStatus).trim() !== '')
      ? String(rawHouseholdStatus).trim()
      : 'ACTIVE';

    if (householdStatus !== 'ACTIVE') {
      return {
        valid: false,
        errorCode: 'household_not_found',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    var rawHouseholdName = props.getProperty('HOUSEHOLD_NAME');
    if ((rawHouseholdName === null || rawHouseholdName === undefined || String(rawHouseholdName).trim() === '') && parsedConfig) {
      rawHouseholdName = parsedConfig.householdName || parsedConfig.household_name;
    }
    var householdName = (rawHouseholdName && String(rawHouseholdName).trim())
      ? String(rawHouseholdName).trim()
      : 'Personal & Family Household';

    var members = [];
    var rawMembersJson = props.getProperty('HOUSEHOLD_MEMBERS_JSON');
    var hasMembersJsonProp = rawMembersJson !== null && rawMembersJson !== undefined;
    var rawMembersSource = null;

    if (hasMembersJsonProp) {
      var trimmedMembersJson = String(rawMembersJson).trim();
      if (!trimmedMembersJson) {
        return {
          valid: false,
          errorCode: 'authorization_configuration_error',
          errorMessage: this.SAFE_ERROR_MESSAGE
        };
      }
      try {
        rawMembersSource = JSON.parse(trimmedMembersJson);
      } catch (_err) {
        Logger.log('Security Warning: Malformed HOUSEHOLD_MEMBERS_JSON in Script Properties.');
        return {
          valid: false,
          errorCode: 'authorization_configuration_error',
          errorMessage: this.SAFE_ERROR_MESSAGE
        };
      }
      if (rawMembersSource && typeof rawMembersSource === 'object' && !Array.isArray(rawMembersSource) && Array.isArray(rawMembersSource.members)) {
        rawMembersSource = rawMembersSource.members;
      }
      if (!Array.isArray(rawMembersSource) || rawMembersSource.length === 0) {
        return {
          valid: false,
          errorCode: 'authorization_configuration_error',
          errorMessage: this.SAFE_ERROR_MESSAGE
        };
      }
    } else if (parsedConfig && parsedConfig.members !== undefined) {
      if (!Array.isArray(parsedConfig.members) || parsedConfig.members.length === 0) {
        return {
          valid: false,
          errorCode: 'authorization_configuration_error',
          errorMessage: this.SAFE_ERROR_MESSAGE
        };
      }
      rawMembersSource = parsedConfig.members;
    }

    if (rawMembersSource !== null) {
      for (var i = 0; i < rawMembersSource.length; i++) {
        var item = rawMembersSource[i];
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return {
            valid: false,
            errorCode: 'authorization_configuration_error',
            errorMessage: this.SAFE_ERROR_MESSAGE
          };
        }

        var itemSub = item.googleSub !== undefined ? item.googleSub : item.google_sub;
        var itemEmail = item.email;

        var normalizedSub = (itemSub !== null && itemSub !== undefined) ? String(itemSub).trim() : '';
        var normalizedEmail = (itemEmail !== null && itemEmail !== undefined) ? String(itemEmail).trim().toLowerCase() : '';

        if (!normalizedSub && !normalizedEmail) {
          return {
            valid: false,
            errorCode: 'authorization_configuration_error',
            errorMessage: this.SAFE_ERROR_MESSAGE
          };
        }

        if (normalizedSub && normalizedSub.indexOf(' ') !== -1) {
          return {
            valid: false,
            errorCode: 'authorization_configuration_error',
            errorMessage: this.SAFE_ERROR_MESSAGE
          };
        }

        if (normalizedEmail && !this.isValidEmailFormat(normalizedEmail)) {
          return {
            valid: false,
            errorCode: 'authorization_configuration_error',
            errorMessage: this.SAFE_ERROR_MESSAGE
          };
        }

        var hasExplicitHousehold = Object.prototype.hasOwnProperty.call(item, 'householdId') ||
                                   Object.prototype.hasOwnProperty.call(item, 'household_id');
        var rawMemberHouseholdId = Object.prototype.hasOwnProperty.call(item, 'householdId')
          ? item.householdId
          : item.household_id;
        var memberHouseholdId = hasExplicitHousehold
          ? (rawMemberHouseholdId !== null && rawMemberHouseholdId !== undefined ? String(rawMemberHouseholdId).trim() : '')
          : householdId;

        var rawRole = item.role;
        var memberRole = (rawRole !== null && rawRole !== undefined) ? String(rawRole).trim() : '';

        var rawStatus = item.status !== undefined ? item.status : item.membership_status;
        var memberStatus = (rawStatus !== null && rawStatus !== undefined && String(rawStatus).trim() !== '')
          ? String(rawStatus).trim()
          : 'ACTIVE';

        var rawUserStatus = item.userStatus !== undefined ? item.userStatus : item.user_status;
        var userStatus = (rawUserStatus !== null && rawUserStatus !== undefined && String(rawUserStatus).trim() !== '')
          ? String(rawUserStatus).trim()
          : 'ACTIVE';

        var rawUserId = item.userId !== undefined ? item.userId : item.user_id;
        var userId = (rawUserId !== null && rawUserId !== undefined && String(rawUserId).trim() !== '')
          ? String(rawUserId).trim()
          : ('usr_' + (i + 1));

        var rawMembershipId = item.membershipId !== undefined ? item.membershipId : item.membership_id;
        var membershipId = (rawMembershipId !== null && rawMembershipId !== undefined && String(rawMembershipId).trim() !== '')
          ? String(rawMembershipId).trim()
          : ('mem_' + (i + 1));

        members.push({
          membershipId: membershipId,
          userId: userId,
          householdId: memberHouseholdId,
          googleSub: normalizedSub,
          email: normalizedEmail,
          role: memberRole,
          status: memberStatus,
          userStatus: userStatus
        });
      }
    } else {
      // Check flat Script Properties for OWNER and PARTNER
      var ownerEmail = props.getProperty('OWNER_EMAIL');
      var ownerSub = props.getProperty('OWNER_GOOGLE_SUB');
      var partnerEmail = props.getProperty('PARTNER_EMAIL');
      var partnerSub = props.getProperty('PARTNER_GOOGLE_SUB');

      var hasOwnerProps = (ownerEmail !== null && ownerEmail !== undefined && String(ownerEmail).trim() !== '') ||
                          (ownerSub !== null && ownerSub !== undefined && String(ownerSub).trim() !== '');
      var hasPartnerProps = (partnerEmail !== null && partnerEmail !== undefined && String(partnerEmail).trim() !== '') ||
                            (partnerSub !== null && partnerSub !== undefined && String(partnerSub).trim() !== '');

      if (!hasOwnerProps && !hasPartnerProps) {
        return {
          valid: false,
          errorCode: 'authorization_configuration_error',
          errorMessage: this.SAFE_ERROR_MESSAGE
        };
      }

      if (hasOwnerProps) {
        var normOwnerEmail = ownerEmail ? String(ownerEmail).trim().toLowerCase() : '';
        var normOwnerSub = ownerSub ? String(ownerSub).trim() : '';
        if (normOwnerEmail && !this.isValidEmailFormat(normOwnerEmail)) {
          return {
            valid: false,
            errorCode: 'authorization_configuration_error',
            errorMessage: this.SAFE_ERROR_MESSAGE
          };
        }
        if (normOwnerSub && normOwnerSub.indexOf(' ') !== -1) {
          return {
            valid: false,
            errorCode: 'authorization_configuration_error',
            errorMessage: this.SAFE_ERROR_MESSAGE
          };
        }
        var rawOwnerRole = props.getProperty('OWNER_ROLE');
        var ownerRole = (rawOwnerRole !== null && rawOwnerRole !== undefined) ? String(rawOwnerRole).trim() : 'OWNER';
        var rawOwnerStatus = props.getProperty('OWNER_STATUS');
        var ownerStatus = (rawOwnerStatus !== null && rawOwnerStatus !== undefined && String(rawOwnerStatus).trim() !== '')
          ? String(rawOwnerStatus).trim()
          : 'ACTIVE';
        var rawOwnerHouseholdId = props.getProperty('OWNER_HOUSEHOLD_ID');
        var ownerHouseholdId = (rawOwnerHouseholdId !== null && rawOwnerHouseholdId !== undefined)
          ? String(rawOwnerHouseholdId).trim()
          : householdId;
        var rawOwnerUserId = props.getProperty('OWNER_USER_ID');
        var ownerUserId = (rawOwnerUserId && String(rawOwnerUserId).trim()) ? String(rawOwnerUserId).trim() : 'usr_owner';

        members.push({
          membershipId: 'mem_owner',
          userId: ownerUserId,
          householdId: ownerHouseholdId,
          googleSub: normOwnerSub,
          email: normOwnerEmail,
          role: ownerRole,
          status: ownerStatus,
          userStatus: 'ACTIVE'
        });
      }

      if (hasPartnerProps) {
        var normPartnerEmail = partnerEmail ? String(partnerEmail).trim().toLowerCase() : '';
        var normPartnerSub = partnerSub ? String(partnerSub).trim() : '';
        if (normPartnerEmail && !this.isValidEmailFormat(normPartnerEmail)) {
          return {
            valid: false,
            errorCode: 'authorization_configuration_error',
            errorMessage: this.SAFE_ERROR_MESSAGE
          };
        }
        if (normPartnerSub && normPartnerSub.indexOf(' ') !== -1) {
          return {
            valid: false,
            errorCode: 'authorization_configuration_error',
            errorMessage: this.SAFE_ERROR_MESSAGE
          };
        }
        var rawPartnerRole = props.getProperty('PARTNER_ROLE');
        var partnerRole = (rawPartnerRole !== null && rawPartnerRole !== undefined) ? String(rawPartnerRole).trim() : 'PARTNER';
        var rawPartnerStatus = props.getProperty('PARTNER_STATUS');
        var partnerStatus = (rawPartnerStatus !== null && rawPartnerStatus !== undefined && String(rawPartnerStatus).trim() !== '')
          ? String(rawPartnerStatus).trim()
          : 'ACTIVE';
        var rawPartnerHouseholdId = props.getProperty('PARTNER_HOUSEHOLD_ID');
        var partnerHouseholdId = (rawPartnerHouseholdId !== null && rawPartnerHouseholdId !== undefined)
          ? String(rawPartnerHouseholdId).trim()
          : householdId;
        var rawPartnerUserId = props.getProperty('PARTNER_USER_ID');
        var partnerUserId = (rawPartnerUserId && String(rawPartnerUserId).trim()) ? String(rawPartnerUserId).trim() : 'usr_partner';

        members.push({
          membershipId: 'mem_partner',
          userId: partnerUserId,
          householdId: partnerHouseholdId,
          googleSub: normPartnerSub,
          email: normPartnerEmail,
          role: partnerRole,
          status: partnerStatus,
          userStatus: 'ACTIVE'
        });
      }
    }

    return {
      valid: true,
      household: {
        householdId: householdId,
        householdName: householdName,
        baseCurrency: 'IDR',
        timezone: 'Asia/Jakarta',
        status: householdStatus
      },
      members: members
    };
  },

  /**
   * Resolves household membership and role for a verified server-side session identity.
   * Fails closed if configuration is invalid, user has no membership, membership is inactive,
   * household reference is missing/mismatched, or role is missing/unknown.
   *
   * @param {Object} sessionIdentity - Verified identity from AuthSession.validateSession().
   * @returns {{
   *   authorized: boolean,
   *   errorCode?: string,
   *   errorMessage?: string,
   *   household?: Object,
   *   member?: Object
   * }}
   */
  resolveMembership: function(sessionIdentity) {
    if (!sessionIdentity || typeof sessionIdentity !== 'object') {
      return {
        authorized: false,
        errorCode: 'unauthenticated',
        errorMessage: this.SAFE_UNAUTHENTICATED_MESSAGE
      };
    }

    var googleSub = sessionIdentity.googleSub ? String(sessionIdentity.googleSub).trim() : '';
    var email = sessionIdentity.email ? String(sessionIdentity.email).trim().toLowerCase() : '';

    if (!googleSub || !email || !this.isValidEmailFormat(email)) {
      return {
        authorized: false,
        errorCode: 'unauthenticated',
        errorMessage: this.SAFE_UNAUTHENTICATED_MESSAGE
      };
    }

    var configResult = this.getHouseholdConfig();
    if (!configResult.valid) {
      return {
        authorized: false,
        errorCode: configResult.errorCode || 'authorization_configuration_error',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    var matchedMember = null;
    for (var i = 0; i < configResult.members.length; i++) {
      var candidate = configResult.members[i];

      if (candidate.googleSub) {
        // When googleSub is configured on the member record, require exact googleSub match
        if (candidate.googleSub === googleSub) {
          // If email is also configured on the record, verify it matches as well
          if (candidate.email && candidate.email !== email) {
            continue;
          }
          matchedMember = candidate;
          break;
        }
      } else if (candidate.email && candidate.email === email) {
        matchedMember = candidate;
        break;
      }
    }

    if (!matchedMember) {
      return {
        authorized: false,
        errorCode: 'membership_not_found',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    // Check user status and membership status
    if (matchedMember.userStatus !== 'ACTIVE' || matchedMember.status !== 'ACTIVE') {
      return {
        authorized: false,
        errorCode: 'membership_inactive',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    // Check member household reference
    if (!matchedMember.householdId) {
      return {
        authorized: false,
        errorCode: 'household_not_found',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    if (!this.isValidHouseholdIdFormat(matchedMember.householdId)) {
      return {
        authorized: false,
        errorCode: 'household_not_found',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    if (matchedMember.householdId !== configResult.household.householdId) {
      return {
        authorized: false,
        errorCode: 'household_access_denied',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    // Check member role
    if (!matchedMember.role) {
      return {
        authorized: false,
        errorCode: 'role_not_found',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    if (!this.isValidRole(matchedMember.role)) {
      return {
        authorized: false,
        errorCode: 'role_not_found',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    return {
      authorized: true,
      household: configResult.household,
      member: {
        membershipId: matchedMember.membershipId,
        userId: matchedMember.userId,
        householdId: matchedMember.householdId,
        googleSub: googleSub,
        email: email,
        role: matchedMember.role,
        status: matchedMember.status
      }
    };
  },

  /**
   * Validates household data isolation for a request or target resource.
   * Rejects any browser attempt to supply a spreadsheet ID, Drive folder ID,
   * malformed household ID, or cross-household resource reference.
   *
   * @param {string} authorizedHouseholdId - Server-resolved household ID.
   * @param {Object} [requestScope] - Optional request payload/parameters/resource metadata.
   * @returns {{
   *   valid: boolean,
   *   errorCode?: string,
   *   errorMessage?: string
   * }}
   */
  validateHouseholdIsolation: function(authorizedHouseholdId, requestScope) {
    if (!this.isValidHouseholdIdFormat(authorizedHouseholdId)) {
      return {
        valid: false,
        errorCode: 'household_not_found',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    if (requestScope === undefined || requestScope === null) {
      return { valid: true };
    }

    if (typeof requestScope !== 'object' || Array.isArray(requestScope)) {
      return {
        valid: false,
        errorCode: 'household_access_denied',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    // 1. Reject any browser-supplied spreadsheet ID or Drive folder ID
    var forbiddenKeys = [
      'spreadsheetId',
      'spreadsheet_id',
      'dbSpreadsheetId',
      'db_spreadsheet_id',
      'driveFolderId',
      'drive_folder_id',
      'attachmentsFolderId',
      'attachments_folder_id'
    ];
    for (var i = 0; i < forbiddenKeys.length; i++) {
      var k = forbiddenKeys[i];
      if (Object.prototype.hasOwnProperty.call(requestScope, k) &&
          requestScope[k] !== undefined &&
          requestScope[k] !== null) {
        return {
          valid: false,
          errorCode: 'household_access_denied',
          errorMessage: this.SAFE_ERROR_MESSAGE
        };
      }
    }

    // 2. Check requested householdId if present
    var hasHouseholdId = Object.prototype.hasOwnProperty.call(requestScope, 'householdId') ||
                         Object.prototype.hasOwnProperty.call(requestScope, 'household_id') ||
                         Object.prototype.hasOwnProperty.call(requestScope, 'requestedHouseholdId');
    if (hasHouseholdId) {
      var reqHouseholdId = requestScope.householdId !== undefined
        ? requestScope.householdId
        : (requestScope.household_id !== undefined ? requestScope.household_id : requestScope.requestedHouseholdId);

      if (reqHouseholdId !== undefined && reqHouseholdId !== null) {
        if (!this.isValidHouseholdIdFormat(reqHouseholdId)) {
          return {
            valid: false,
            errorCode: 'household_access_denied',
            errorMessage: this.SAFE_ERROR_MESSAGE
          };
        }
        if (String(reqHouseholdId).trim() !== authorizedHouseholdId) {
          return {
            valid: false,
            errorCode: 'household_access_denied',
            errorMessage: this.SAFE_ERROR_MESSAGE
          };
        }
      }
    }

    // 3. Check target resource household ownership if present
    var hasResourceHouseholdId = Object.prototype.hasOwnProperty.call(requestScope, 'resourceHouseholdId') ||
                                 Object.prototype.hasOwnProperty.call(requestScope, 'resource_household_id');
    if (hasResourceHouseholdId) {
      var resHouseholdId = requestScope.resourceHouseholdId !== undefined
        ? requestScope.resourceHouseholdId
        : requestScope.resource_household_id;

      if (!this.isValidHouseholdIdFormat(resHouseholdId) || String(resHouseholdId).trim() !== authorizedHouseholdId) {
        return {
          valid: false,
          errorCode: 'household_access_denied',
          errorMessage: this.SAFE_ERROR_MESSAGE
        };
      }
    }

    // 4. Check nested resource object if present
    if (Object.prototype.hasOwnProperty.call(requestScope, 'resource') && requestScope.resource !== undefined && requestScope.resource !== null) {
      var resObj = requestScope.resource;
      if (typeof resObj !== 'object' || Array.isArray(resObj)) {
        return {
          valid: false,
          errorCode: 'household_access_denied',
          errorMessage: this.SAFE_ERROR_MESSAGE
        };
      }
      if (Object.prototype.hasOwnProperty.call(resObj, 'spreadsheetId') ||
          Object.prototype.hasOwnProperty.call(resObj, 'spreadsheet_id')) {
        return {
          valid: false,
          errorCode: 'household_access_denied',
          errorMessage: this.SAFE_ERROR_MESSAGE
        };
      }
      var nestedHhId = resObj.householdId !== undefined ? resObj.householdId : resObj.household_id;
      if (!this.isValidHouseholdIdFormat(nestedHhId) || String(nestedHhId).trim() !== authorizedHouseholdId) {
        return {
          valid: false,
          errorCode: 'household_access_denied',
          errorMessage: this.SAFE_ERROR_MESSAGE
        };
      }
    }

    return { valid: true };
  },

  /**
   * Complete server-side authorization pipeline for protected operations.
   *
   * 1. Validates the application session token via AuthSession.validateSession().
   * 2. Rejects missing, invalid, expired, or revoked sessions ('unauthenticated').
   * 3. Resolves authenticated identity strictly from the server-side session record.
   * 4. Resolves household membership and role server-side.
   * 5. Evaluates required permission against the resolved role (default-deny).
   * 6. Enforces household data isolation against requestScope.
   * 7. Produces an immutable server-side authorization context.
   *
   * @param {string} sessionToken - Raw application session token.
   * @param {string} [requiredPermission] - Required permission string (defaults to 'household.view' if undefined).
   * @param {Object} [requestScope] - Optional request parameters or target resource metadata.
   * @returns {{
   *   authorized: boolean,
   *   authenticated: boolean,
   *   errorCode?: string,
   *   sessionError?: string,
   *   errorMessage?: string,
   *   context?: Object
   * }}
   */
  authorizeRequest: function(sessionToken, requiredPermission, requestScope) {
    // Step 1 & 2: Validate application session server-side
    if (typeof AuthSession === 'undefined' || !AuthSession.validateSession) {
      return {
        authorized: false,
        authenticated: false,
        errorCode: 'authorization_configuration_error',
        errorMessage: this.SAFE_ERROR_MESSAGE
      };
    }

    var sessionResult = AuthSession.validateSession(sessionToken);
    if (!sessionResult || !sessionResult.valid) {
      return {
        authorized: false,
        authenticated: false,
        errorCode: 'unauthenticated',
        sessionError: (sessionResult && sessionResult.error) ? sessionResult.error : 'invalid_session',
        errorMessage: this.SAFE_UNAUTHENTICATED_MESSAGE
      };
    }

    // Step 3 & 4: Resolve household membership using ONLY the server-validated session identity
    var membershipResult = this.resolveMembership({
      googleSub: sessionResult.googleSub,
      email: sessionResult.email,
      name: sessionResult.name
    });

    if (!membershipResult.authorized) {
      return {
        authorized: false,
        authenticated: true,
        errorCode: membershipResult.errorCode || 'membership_not_found',
        errorMessage: membershipResult.errorMessage || this.SAFE_ERROR_MESSAGE
      };
    }

    var resolvedRole = membershipResult.member.role;
    var resolvedHousehold = membershipResult.household;

    // Step 5: Evaluate role permission
    var permToCheck = (arguments.length < 2 || requiredPermission === undefined)
      ? 'household.view'
      : requiredPermission;

    var permResult = this.evaluateRolePermission(resolvedRole, permToCheck);
    if (!permResult.permitted) {
      return {
        authorized: false,
        authenticated: true,
        errorCode: permResult.errorCode || 'permission_denied',
        errorMessage: permResult.errorMessage || this.SAFE_ERROR_MESSAGE
      };
    }

    // Step 6: Enforce household data isolation
    var isolationResult = this.validateHouseholdIsolation(resolvedHousehold.householdId, requestScope);
    if (!isolationResult.valid) {
      return {
        authorized: false,
        authenticated: true,
        errorCode: isolationResult.errorCode || 'household_access_denied',
        errorMessage: isolationResult.errorMessage || this.SAFE_ERROR_MESSAGE
      };
    }

    // Step 7: Build immutable server-side authorization context
    var permissionsList = this.getPermissionsForRole(resolvedRole);
    var actorObj = {
      userId: membershipResult.member.userId,
      membershipId: membershipResult.member.membershipId,
      googleSub: sessionResult.googleSub,
      email: sessionResult.email,
      name: sessionResult.name || '',
      role: resolvedRole,
      membershipStatus: membershipResult.member.status
    };
    var householdObj = {
      householdId: resolvedHousehold.householdId,
      householdName: resolvedHousehold.householdName,
      baseCurrency: resolvedHousehold.baseCurrency,
      timezone: resolvedHousehold.timezone,
      status: resolvedHousehold.status
    };

    var authContext = {
      authenticated: true,
      authorized: true,
      sessionId: sessionResult.sessionId,
      actor: Object.freeze(actorObj),
      household: Object.freeze(householdObj),
      role: resolvedRole,
      permissions: Object.freeze(permissionsList)
    };

    return {
      authorized: true,
      authenticated: true,
      context: Object.freeze(authContext)
    };
  },

  /**
   * Executes a protected operation callback ONLY after full server-side authorization succeeds.
   * Guarantees that protected business logic never executes when authentication,
   * membership, role permission, or household isolation fails.
   *
   * @param {string} sessionToken - Raw application session token.
   * @param {string} requiredPermission - Required permission identifier.
   * @param {Object} requestScope - Request parameters or resource scope to validate.
   * @param {Function} operationCallback - Callback invoked with (authContext) only if authorized.
   * @returns {Object} Authorization failure response or operation result.
   */
  authorizeAndExecute: function(sessionToken, requiredPermission, requestScope, operationCallback) {
    var authResult = this.authorizeRequest(sessionToken, requiredPermission, requestScope);
    if (!authResult.authorized) {
      return {
        success: false,
        authorized: false,
        authenticated: authResult.authenticated,
        errorCode: authResult.errorCode,
        errorMessage: authResult.errorMessage
      };
    }

    if (typeof operationCallback !== 'function') {
      return {
        success: true,
        authorized: true,
        authenticated: true,
        context: authResult.context
      };
    }

    var data = operationCallback(authResult.context);
    return {
      success: true,
      authorized: true,
      authenticated: true,
      data: data
    };
  }
};
