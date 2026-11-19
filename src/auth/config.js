/**
 * AuthConfig module
 * Manages configuration, state generation, and URL creation for
 * Google OAuth 2.0 Authorization Code Flow.
 */
var AuthConfig = {
  /**
   * Retrieves the configured Google OAuth 2.0 Web Client ID.
   * Checks Script Properties for 'OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_ID', or 'GIS_CLIENT_ID'.
   *
   * @returns {string} The configured client ID, or empty string if not configured.
   */
  getClientId: function() {
    try {
      var props = PropertiesService.getScriptProperties();
      var clientId = props.getProperty('OAUTH_CLIENT_ID') ||
                     props.getProperty('GOOGLE_OAUTH_CLIENT_ID') ||
                     props.getProperty('GIS_CLIENT_ID');
      return clientId ? String(clientId).trim() : '';
    } catch (err) {
      Logger.log('Warning: Unable to access Script Properties for Client ID: ' + err.message);
      return '';
    }
  },

  /**
   * Backwards-compatible alias for getClientId.
   *
   * @returns {string}
   */
  getGisClientId: function() {
    return this.getClientId();
  },

  /**
   * Retrieves the OAuth 2.0 redirect URI.
   * Checks Script Properties for 'OAUTH_REDIRECT_URI' or 'WEBAPP_URL',
   * and falls back to ScriptApp.getService().getUrl().
   *
   * @returns {string} The redirect URI, or empty string if unavailable.
   */
  getRedirectUri: function() {
    try {
      var props = PropertiesService.getScriptProperties();
      var redirectUri = props.getProperty('OAUTH_REDIRECT_URI') || props.getProperty('WEBAPP_URL');
      if (redirectUri && String(redirectUri).trim()) {
        return String(redirectUri).trim();
      }
    } catch (err) {
      Logger.log('Warning: Unable to access Script Properties for Redirect URI: ' + err.message);
    }

    try {
      if (typeof ScriptApp !== 'undefined' && ScriptApp.getService) {
        var service = ScriptApp.getService();
        if (service && service.getUrl) {
          var serviceUrl = service.getUrl();
          if (serviceUrl) {
            return String(serviceUrl).trim();
          }
        }
      }
    } catch (errService) {
      Logger.log('Warning: Unable to resolve Web App service URL: ' + errService.message);
    }

    return '';
  },

  /**
   * Generates a cryptographically random state token and caches it
   * for CSRF protection with a 10-minute TTL.
   *
   * @returns {string} The generated state token, or empty string on failure.
   */
  createState: function() {
    try {
      var stateToken = Utilities.getUuid();
      var cache = CacheService.getScriptCache();
      if (cache) {
        cache.put('oauth_state_' + stateToken, 'valid', 600);
      }
      return stateToken;
    } catch (err) {
      Logger.log('Error: Failed to create and cache OAuth state token: ' + err.message);
      return '';
    }
  },

  /**
   * Validates and immediately consumes an OAuth state token (one-time use).
   * Prevents replay and CSRF attacks.
   *
   * @param {string} state - The state parameter received in the OAuth callback.
   * @returns {boolean} True if the state token was valid and consumed; false otherwise.
   */
  validateState: function(state) {
    if (!state || typeof state !== 'string' || !state.trim()) {
      return false;
    }
    try {
      var trimmed = state.trim();
      var cache = CacheService.getScriptCache();
      if (!cache) {
        return false;
      }
      var cachedVal = cache.get('oauth_state_' + trimmed);
      if (cachedVal === 'valid') {
        // One-time consumption: immediately remove to prevent replay
        cache.remove('oauth_state_' + trimmed);
        return true;
      }
      return false;
    } catch (err) {
      Logger.log('Error: Failed to validate OAuth state token: ' + err.message);
      return false;
    }
  },

  /**
   * Builds the Google OAuth 2.0 authorization URL.
   *
   * @param {string} [state] - Optional pre-generated state token. If omitted, generates one.
   * @returns {string} Google authorization URL, or empty string if client ID / redirect URI is missing.
   */
  getAuthorizationUrl: function(state) {
    var clientId = this.getClientId();
    var redirectUri = this.getRedirectUri();
    if (!clientId || !redirectUri) {
      return '';
    }

    var stateParam = state || this.createState();
    var baseAuthUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
    var params = [
      'client_id=' + encodeURIComponent(clientId),
      'redirect_uri=' + encodeURIComponent(redirectUri),
      'response_type=code',
      'scope=' + encodeURIComponent('openid email profile'),
      'state=' + encodeURIComponent(stateParam),
      'prompt=select_account',
      'access_type=online'
    ];

    return baseAuthUrl + '?' + params.join('&');
  },

  /**
   * Returns safe public configuration for frontend consumption.
   * NEVER include client secrets, private keys, or internal credentials here.
   *
   * @returns {{ clientId: string, redirectUri: string }}
   */
  getPublicConfig: function() {
    return {
      clientId: this.getClientId(),
      redirectUri: this.getRedirectUri()
    };
  }
};
