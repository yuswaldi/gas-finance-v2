/**
 * AuthSession module
 * Implements secure server-side application session management for Personal & Family Finance Manager.
 * Issues cryptographically secure, unpredictable application session tokens.
 * Stores only SHA-256 token hashes server-side in PropertiesService (persistent) and CacheService (read-through cache).
 * Enforces finite absolute lifetime (12 hours) and idle timeout (30 minutes).
 */
var AuthSession = {
  /**
   * Default session lifetime in seconds (12 hours).
   */
  ABSOLUTE_LIFETIME_SECONDS: 43200,

  /**
   * Default idle timeout in seconds (30 minutes).
   */
  IDLE_TIMEOUT_SECONDS: 1800,

  /**
   * Storage key prefix for session records.
   */
  STORAGE_KEY_PREFIX: 'sess_',

  /**
   * Generates a cryptographically secure random session token.
   * Concatenates three RFC 4122 v4 UUIDs without hyphens to provide 366 bits of entropy.
   * Does NOT use Math.random().
   *
   * @returns {string} 96-character lowercase hex string.
   */
  generateSessionToken: function() {
    var p1 = Utilities.getUuid().replace(/-/g, '');
    var p2 = Utilities.getUuid().replace(/-/g, '');
    var p3 = Utilities.getUuid().replace(/-/g, '');
    return (p1 + p2 + p3).toLowerCase();
  },

  /**
   * Computes SHA-256 digest of a session token formatted as 64-character lowercase hex.
   *
   * @param {string} token - Raw session token.
   * @returns {string} SHA-256 hex string, or empty string if invalid.
   */
  hashToken: function(token) {
    if (!token || typeof token !== 'string') {
      return '';
    }
    var rawDigest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      token.trim(),
      Utilities.Charset.UTF_8
    );
    var hex = '';
    for (var i = 0; i < rawDigest.length; i++) {
      hex += ('0' + (rawDigest[i] & 0xFF).toString(16)).slice(-2);
    }
    return hex;
  },

  /**
   * Constant-time string equality comparison to prevent timing attacks.
   *
   * @param {string} a
   * @param {string} b
   * @returns {boolean}
   */
  constantTimeEquals: function(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
      return false;
    }
    if (a.length !== b.length) {
      return false;
    }
    var result = 0;
    for (var i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  },

  /**
   * Retrieves the configured absolute session lifetime in milliseconds.
   * Reads optional SESSION_LIFETIME_SECONDS property, defaults to 12 hours.
   *
   * @returns {number} Lifetime in milliseconds.
   */
  getAbsoluteLifetimeMs: function() {
    try {
      var props = PropertiesService.getScriptProperties();
      if (props) {
        var customSec = Number(props.getProperty('SESSION_LIFETIME_SECONDS'));
        if (!isNaN(customSec) && customSec > 0) {
          return customSec * 1000;
        }
      }
    } catch (_e) {
      // Fallback to default
    }
    return this.ABSOLUTE_LIFETIME_SECONDS * 1000;
  },

  /**
   * Retrieves the configured idle session timeout in milliseconds.
   * Reads optional SESSION_IDLE_TIMEOUT_SECONDS property, defaults to 30 minutes.
   *
   * @returns {number} Idle timeout in milliseconds.
   */
  getIdleTimeoutMs: function() {
    try {
      var props = PropertiesService.getScriptProperties();
      if (props) {
        var customSec = Number(props.getProperty('SESSION_IDLE_TIMEOUT_SECONDS'));
        if (!isNaN(customSec) && customSec > 0) {
          return customSec * 1000;
        }
      }
    } catch (_e) {
      // Fallback to default
    }
    return this.IDLE_TIMEOUT_SECONDS * 1000;
  },

  /**
   * Creates a new application session for a verified and allowlisted Google identity.
   * Generates a cryptographically strong opaque token, stores its SHA-256 hash, and returns
   * the raw token ONLY ONCE.
   *
   * @param {Object} identity - Verified identity object from FFM-008 and FFM-009.
   * @returns {{
   *   success: boolean,
   *   token?: string,
   *   sessionId?: string,
   *   expiresAt?: number,
   *   error?: string,
   *   errorMessage?: string
   * }}
   */
  createSession: function(identity) {
    if (!identity || typeof identity !== 'object') {
      return {
        success: false,
        error: 'invalid_identity',
        errorMessage: 'Identity object is missing or invalid.'
      };
    }

    var googleSub = identity.googleSub ? String(identity.googleSub).trim() : '';
    var email = identity.email ? String(identity.email).trim().toLowerCase() : '';

    if (!googleSub || !email || identity.emailVerified !== true) {
      return {
        success: false,
        error: 'unverified_identity',
        errorMessage: 'Identity must have a valid googleSub, email, and emailVerified=true.'
      };
    }

    var props;
    try {
      props = PropertiesService.getScriptProperties();
    } catch (err) {
      Logger.log('Error accessing Script Properties: ' + err.message);
      return {
        success: false,
        error: 'storage_error',
        errorMessage: 'Failed to access server-side session storage.'
      };
    }

    if (!props) {
      return {
        success: false,
        error: 'storage_error',
        errorMessage: 'Session storage is unavailable.'
      };
    }

    var lock = LockService.getScriptLock();
    var hasLock = false;
    try {
      hasLock = lock.tryLock(5000);
    } catch (lockErr) {
      Logger.log('LockService warning: ' + lockErr.message);
    }

    if (!hasLock) {
      return {
        success: false,
        error: 'lock_timeout',
        errorMessage: 'Could not acquire lock to create application session.'
      };
    }

    try {
      var rawToken = this.generateSessionToken();
      var tokenHash = this.hashToken(rawToken);
      var sessionId = Utilities.getUuid();
      var now = Date.now();
      var expiresAt = now + this.getAbsoluteLifetimeMs();

      var sessionRecord = {
        sessionId: sessionId,
        tokenHash: tokenHash,
        googleSub: googleSub,
        email: email,
        name: identity.name ? String(identity.name).trim() : '',
        picture: identity.picture ? String(identity.picture).trim() : '',
        createdAt: now,
        lastSeenAt: now,
        expiresAt: expiresAt,
        status: 'ACTIVE'
      };

      var storageKey = this.STORAGE_KEY_PREFIX + tokenHash;
      var serialized = JSON.stringify(sessionRecord);

      // Store persistently in Script Properties
      props.setProperty(storageKey, serialized);

      // Store in CacheService for fast read-through validation
      try {
        var cache = CacheService.getScriptCache();
        if (cache) {
          var cacheTtl = Math.min(Math.floor(this.getIdleTimeoutMs() / 1000), 21600);
          cache.put(storageKey, serialized, cacheTtl);
        }
      } catch (_cacheErr) {
        // Cache failure is non-fatal since PropertiesService is persistent
      }

      return {
        success: true,
        token: rawToken,
        sessionId: sessionId,
        expiresAt: expiresAt
      };
    } catch (err) {
      Logger.log('Error creating session: ' + err.message);
      return {
        success: false,
        error: 'session_creation_failed',
        errorMessage: 'Failed to create application session.'
      };
    } finally {
      try {
        lock.releaseLock();
      } catch (_e) {
        // Lock already released
      }
    }
  },

  /**
   * Validates a presented application session token.
   * Retrieves the session record via token hash, performs constant-time hash verification,
   * enforces active status, finite absolute expiration, and idle timeout.
   *
   * @param {string} token - The raw application session token.
   * @returns {{
   *   valid: boolean,
   *   sessionId?: string,
   *   googleSub?: string,
   *   email?: string,
   *   name?: string,
   *   createdAt?: number,
   *   expiresAt?: number,
   *   lastSeenAt?: number,
   *   error?: string,
   *   errorMessage?: string
   * }}
   */
  validateSession: function(token) {
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      return {
        valid: false,
        error: 'missing_session',
        errorMessage: 'Application session token is missing or empty.'
      };
    }

    var trimmed = token.trim();
    // Session tokens must be exact hex strings of at least 64 characters
    if (!/^[0-9a-f]{64,}$/i.test(trimmed)) {
      return {
        valid: false,
        error: 'malformed_session',
        errorMessage: 'Application session token is malformed.'
      };
    }

    var tokenHash = this.hashToken(trimmed);
    var storageKey = this.STORAGE_KEY_PREFIX + tokenHash;

    var rawRecord = null;
    // 1. Check read-through cache first
    try {
      var cache = CacheService.getScriptCache();
      if (cache) {
        rawRecord = cache.get(storageKey);
      }
    } catch (_cacheErr) {
      rawRecord = null;
    }

    // 2. Fall back to persistent Script Properties
    if (!rawRecord) {
      try {
        var props = PropertiesService.getScriptProperties();
        if (props) {
          rawRecord = props.getProperty(storageKey);
          // Re-populate cache on persistent hit
          if (rawRecord) {
            try {
              var c = CacheService.getScriptCache();
              if (c) {
                var cTtl = Math.min(Math.floor(this.getIdleTimeoutMs() / 1000), 21600);
                c.put(storageKey, rawRecord, cTtl);
              }
            } catch (_e) {
              // Ignore cache put error
            }
          }
        }
      } catch (propsErr) {
        Logger.log('Error reading session from Script Properties: ' + propsErr.message);
        return {
          valid: false,
          error: 'storage_error',
          errorMessage: 'Session storage error during validation.'
        };
      }
    }

    if (!rawRecord) {
      return {
        valid: false,
        error: 'invalid_session',
        errorMessage: 'Application session not found or has expired.'
      };
    }

    var record;
    try {
      record = JSON.parse(rawRecord);
    } catch (_parseErr) {
      return {
        valid: false,
        error: 'invalid_session',
        errorMessage: 'Corrupted session record.'
      };
    }

    if (!record || typeof record !== 'object') {
      return {
        valid: false,
        error: 'invalid_session',
        errorMessage: 'Invalid session record structure.'
      };
    }

    // 3. Constant-time comparison of tokenHash
    if (!this.constantTimeEquals(record.tokenHash, tokenHash)) {
      return {
        valid: false,
        error: 'invalid_session',
        errorMessage: 'Session token mismatch.'
      };
    }

    // 4. Status check
    if (record.status !== 'ACTIVE') {
      return {
        valid: false,
        error: 'invalid_session',
        errorMessage: 'Application session is no longer active.'
      };
    }

    var now = Date.now();

    // 5. Absolute lifetime check
    if (now >= record.expiresAt) {
      return {
        valid: false,
        error: 'expired_session',
        errorMessage: 'Application session has reached its maximum lifetime.'
      };
    }

    // 6. Idle timeout check
    var idleLimitMs = this.getIdleTimeoutMs();
    if (now - record.lastSeenAt >= idleLimitMs) {
      return {
        valid: false,
        error: 'expired_session',
        errorMessage: 'Application session has timed out due to inactivity.'
      };
    }

    // 7. Update lastSeenAt (write to cache; throttle persistent update to once per minute)
    var prevLastSeen = record.lastSeenAt;
    record.lastSeenAt = now;
    var updatedSerialized = JSON.stringify(record);

    try {
      var cacheInst = CacheService.getScriptCache();
      if (cacheInst) {
        var remTtl = Math.min(Math.floor(idleLimitMs / 1000), 21600);
        cacheInst.put(storageKey, updatedSerialized, remTtl);
      }
    } catch (_e) {
      // Non-fatal cache put error
    }

    // If more than 60 seconds have elapsed since last persistent write, update PropertiesService
    if (now - prevLastSeen >= 60000) {
      try {
        var p = PropertiesService.getScriptProperties();
        if (p) {
          p.setProperty(storageKey, updatedSerialized);
        }
      } catch (_propErr) {
        // Non-fatal throttle write error
      }
    }

    // 8. Return safe authenticated identity (NEVER returns token or tokenHash)
    return {
      valid: true,
      sessionId: record.sessionId,
      googleSub: record.googleSub,
      email: record.email,
      name: record.name,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      lastSeenAt: record.lastSeenAt
    };
  },

  /**
   * Revokes an existing application session (FFM-011).
   * Identifies the session by presented token, derives SHA-256 hash, marks status as REVOKED,
   * purges it from CacheService, and prevents any future validation of this token.
   * Handles missing, malformed, unknown, and already revoked sessions safely.
   *
   * @param {string} token - Raw session token.
   * @returns {{
   *   success: boolean,
   *   revoked: boolean,
   *   code?: string,
   *   message?: string,
   *   error?: string,
   *   errorMessage?: string
   * }}
   */
  revokeSession: function(token) {
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      return {
        success: true,
        revoked: false,
        code: 'missing_session',
        message: 'No active session token provided.'
      };
    }

    var trimmed = token.trim();
    if (!/^[0-9a-f]{64,}$/i.test(trimmed)) {
      return {
        success: true,
        revoked: false,
        code: 'malformed_session',
        message: 'Invalid session token format.'
      };
    }

    var tokenHash = this.hashToken(trimmed);
    var storageKey = this.STORAGE_KEY_PREFIX + tokenHash;

    // Purge from cache immediately
    try {
      var cache = CacheService.getScriptCache();
      if (cache) {
        cache.remove(storageKey);
      }
    } catch (_cacheErr) {
      // Non-fatal cache eviction error
    }

    var props;
    try {
      props = PropertiesService.getScriptProperties();
    } catch (err) {
      Logger.log('Error accessing Script Properties during revocation: ' + err.message);
      return {
        success: false,
        revoked: false,
        error: 'storage_error',
        errorMessage: 'Failed to access session storage for revocation.'
      };
    }

    if (!props) {
      return {
        success: false,
        revoked: false,
        error: 'storage_error',
        errorMessage: 'Session storage is unavailable.'
      };
    }

    var lock = LockService.getScriptLock();
    var hasLock = false;
    try {
      hasLock = lock.tryLock(5000);
    } catch (lockErr) {
      Logger.log('LockService warning during revocation: ' + lockErr.message);
    }

    if (!hasLock) {
      return {
        success: false,
        revoked: false,
        error: 'lock_timeout',
        errorMessage: 'Could not acquire lock to revoke session.'
      };
    }

    try {
      var rawRecord = props.getProperty(storageKey);
      if (!rawRecord) {
        return {
          success: true,
          revoked: false,
          code: 'not_found',
          message: 'Session not found or already removed.'
        };
      }

      var record;
      try {
        record = JSON.parse(rawRecord);
      } catch (_e) {
        props.deleteProperty(storageKey);
        return {
          success: true,
          revoked: true,
          code: 'corrupted_removed',
          message: 'Corrupted session record removed.'
        };
      }

      if (!record || typeof record !== 'object') {
        props.deleteProperty(storageKey);
        return {
          success: true,
          revoked: true,
          code: 'invalid_removed',
          message: 'Invalid session record removed.'
        };
      }

      // If already revoked, maintain revocation state idempotently
      if (record.status === 'REVOKED') {
        return {
          success: true,
          revoked: false,
          code: 'already_revoked',
          message: 'Session is already revoked.'
        };
      }

      var now = Date.now();
      record.status = 'REVOKED';
      record.revokedAt = now;
      props.setProperty(storageKey, JSON.stringify(record));

      return {
        success: true,
        revoked: true,
        message: 'Session successfully revoked.'
      };
    } catch (err) {
      Logger.log('Error revoking session: ' + err.message);
      return {
        success: false,
        revoked: false,
        error: 'revocation_failed',
        errorMessage: 'Failed to revoke application session.'
      };
    } finally {
      try {
        lock.releaseLock();
      } catch (_e) {
        // Lock already released
      }
    }
  }
};
