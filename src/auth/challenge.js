/**
 * OAuthChallenge module
 * Implements server-issued OAuth challenge generation and atomic one-time consumption
 * for Google OAuth 2.0 Authorization Code Flow (OIDC + PKCE S256).
 */
var OAuthChallenge = {
  /**
   * Default challenge TTL in seconds (10 minutes).
   */
  DEFAULT_TTL_SECONDS: 600,

  /**
   * Minimum TTL in seconds (5 minutes).
   */
  MIN_TTL_SECONDS: 300,

  /**
   * Maximum TTL in seconds (10 minutes).
   */
  MAX_TTL_SECONDS: 600,

  /**
   * Generates a high-entropy random token using independent UUID generation.
   * Concatenates two RFC 4122 v4 UUIDs without hyphens to provide 244 bits of entropy.
   *
   * @returns {string} 64-character lowercase hex string.
   */
  generateToken: function() {
    var part1 = Utilities.getUuid().replace(/-/g, '');
    var part2 = Utilities.getUuid().replace(/-/g, '');
    return (part1 + part2).toLowerCase();
  },

  /**
   * Computes PKCE code_challenge from code_verifier using SHA-256 and Base64URL encoding without padding.
   * Conforms strictly to RFC 7636 Section 4.2.
   *
   * @param {string} verifier - The high-entropy code_verifier string.
   * @returns {string} Base64URL-encoded SHA-256 digest without '=' padding.
   */
  computeCodeChallenge: function(verifier) {
    if (!verifier || typeof verifier !== 'string') {
      throw new Error('PKCE verifier must be a non-empty string');
    }
    var rawDigest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      verifier,
      Utilities.Charset.US_ASCII
    );
    var base64Web = Utilities.base64EncodeWebSafe(rawDigest);
    // Strip trailing '=' padding per RFC 7636 Section 3
    return base64Web.replace(/=+$/, '');
  },

  /**
   * Derives a cryptographic hash of the state parameter to use as the cache key.
   * Prevents raw state tokens from appearing in cache keys or log traces.
   *
   * @param {string} state - The raw OAuth state token.
   * @returns {string} 64-character hex string representing SHA-256 of state.
   */
  hashState: function(state) {
    if (!state || typeof state !== 'string') {
      return '';
    }
    var rawDigest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      state.trim(),
      Utilities.Charset.UTF_8
    );
    var hex = '';
    for (var i = 0; i < rawDigest.length; i++) {
      hex += ('0' + (rawDigest[i] & 0xFF).toString(16)).slice(-2);
    }
    return hex;
  },

  /**
   * Generates a complete, server-issued OAuth challenge.
   * Stores the challenge record in CacheService with short TTL.
   *
   * @param {Object} [options] - Optional settings (e.g. { ttlSeconds: 600 }).
   * @returns {{
   *   state: string,
   *   nonce: string,
   *   codeChallenge: string,
   *   codeChallengeMethod: string,
   *   expiresAt: number
   * }} Public challenge data needed for the authorization request.
   */
  create: function(options) {
    var ttl = (options && options.ttlSeconds) ? Number(options.ttlSeconds) : this.DEFAULT_TTL_SECONDS;
    if (isNaN(ttl) || ttl < this.MIN_TTL_SECONDS) {
      ttl = this.MIN_TTL_SECONDS;
    } else if (ttl > this.MAX_TTL_SECONDS) {
      ttl = this.MAX_TTL_SECONDS;
    }

    var state = this.generateToken();
    var nonce = this.generateToken();
    var codeVerifier = this.generateToken();
    var codeChallenge = this.computeCodeChallenge(codeVerifier);
    var stateHash = this.hashState(state);

    var now = Date.now();
    var expiresAt = now + (ttl * 1000);

    var redirectUri = (options && options.redirectUri) ? String(options.redirectUri).trim() : '';

    var challengeRecord = {
      stateHash: stateHash,
      nonce: nonce,
      codeVerifier: codeVerifier,
      codeChallenge: codeChallenge,
      redirectUri: redirectUri,
      createdAt: now,
      expiresAt: expiresAt
    };

    var cache = CacheService.getScriptCache();
    if (!cache) {
      Logger.log('Error: CacheService is not available to store OAuth challenge.');
      throw new Error('CacheService unavailable');
    }

    var cacheKey = 'oauth_ch_' + stateHash;
    cache.put(cacheKey, JSON.stringify(challengeRecord), ttl);

    return {
      state: state,
      nonce: nonce,
      codeChallenge: codeChallenge,
      codeChallengeMethod: 'S256',
      expiresAt: expiresAt
    };
  },

  /**
   * Atomically validates and consumes an OAuth challenge record.
   * Uses LockService.getScriptLock to prevent concurrent duplicate consumption.
   * Deletes the cache entry immediately (one-time use).
   *
   * @param {string} state - The state parameter from the OAuth callback.
   * @returns {{
   *   state: string,
   *   nonce: string,
   *   codeVerifier: string,
   *   codeChallenge: string,
   *   createdAt: number,
   *   expiresAt: number
   * }|null} Challenge data if valid and consumed; null otherwise.
   */
  consume: function(state) {
    if (!state || typeof state !== 'string') {
      return null;
    }
    var trimmed = state.trim();
    if (!trimmed || trimmed.length < 32 || trimmed.length > 128) {
      return null;
    }

    var stateHash = this.hashState(trimmed);
    if (!stateHash) {
      return null;
    }
    var cacheKey = 'oauth_ch_' + stateHash;

    var lock = LockService.getScriptLock();
    var hasLock = false;

    try {
      // Wait up to 10 seconds to acquire lock
      hasLock = lock.tryLock(10000);
      if (!hasLock) {
        Logger.log('Warning: LockService timeout trying to acquire lock for challenge consumption.');
        return null;
      }

      var cache = CacheService.getScriptCache();
      if (!cache) {
        Logger.log('Warning: CacheService is unavailable during challenge consumption.');
        return null;
      }

      var recordJson = cache.get(cacheKey);
      if (!recordJson) {
        // Cache miss, expired, or already consumed
        return null;
      }

      var record;
      try {
        record = JSON.parse(recordJson);
      } catch (_parseErr) {
        cache.remove(cacheKey);
        return null;
      }

      if (!record || !record.nonce || !record.codeVerifier || !record.expiresAt) {
        cache.remove(cacheKey);
        return null;
      }

      // Check expiration
      if (Date.now() > record.expiresAt) {
        cache.remove(cacheKey);
        return null;
      }

      // One-time consumption: delete immediately while holding lock
      cache.remove(cacheKey);

      return {
        state: trimmed,
        nonce: record.nonce,
        codeVerifier: record.codeVerifier,
        codeChallenge: record.codeChallenge,
        redirectUri: record.redirectUri || '',
        createdAt: record.createdAt,
        expiresAt: record.expiresAt
      };
    } catch (err) {
      Logger.log('Error in OAuthChallenge.consume: ' + err.message);
      return null;
    } finally {
      if (hasLock) {
        lock.releaseLock();
      }
    }
  }
};
