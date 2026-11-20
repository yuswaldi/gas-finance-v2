/**
 * AuthConfig module
 * Manages configuration, challenge orchestration, callback validation, and URL creation
 * for Google OAuth 2.0 Authorization Code Flow.
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
   * Creates a server-issued OAuth challenge (state, nonce, PKCE verifier/challenge).
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
  createChallenge: function(options) {
    return OAuthChallenge.create(options);
  },

  /**
   * Atomically validates and consumes an OAuth challenge record.
   *
   * @param {string} state - The state parameter received in callback.
   * @returns {Object|null} Challenge data if valid and consumed; null otherwise.
   */
  consumeChallenge: function(state) {
    return OAuthChallenge.consume(state);
  },

  /**
   * Generates a random state token via OAuthChallenge.
   * Kept for backwards compatibility with earlier PoC calls.
   *
   * @returns {string} The generated state token.
   */
  createState: function() {
    try {
      var challenge = OAuthChallenge.create();
      return challenge.state;
    } catch (err) {
      Logger.log('Error in AuthConfig.createState: ' + err.message);
      return '';
    }
  },

  /**
   * Validates and immediately consumes an OAuth state token (one-time use).
   * Kept for backwards compatibility with earlier PoC calls.
   *
   * @param {string} state - The state parameter received in the OAuth callback.
   * @returns {boolean} True if the state token was valid and consumed; false otherwise.
   */
  validateState: function(state) {
    var challenge = OAuthChallenge.consume(state);
    return !!challenge;
  },

  /**
   * Builds the Google OAuth 2.0 authorization URL.
   * Includes state, nonce, and PKCE S256 parameters.
   *
   * @param {Object|string} [challengeOrState] - Pre-generated challenge object or state string.
   * @returns {string} Google authorization URL, or empty string if client ID / redirect URI is missing.
   */
  getAuthorizationUrl: function(challengeOrState) {
    var clientId = this.getClientId();
    var redirectUri = this.getRedirectUri();
    if (!clientId || !redirectUri) {
      return '';
    }

    var challenge;
    if (challengeOrState && typeof challengeOrState === 'object' && challengeOrState.state) {
      challenge = challengeOrState;
    } else if (typeof challengeOrState === 'string' && challengeOrState.trim()) {
      challenge = {
        state: challengeOrState.trim(),
        nonce: '',
        codeChallenge: '',
        codeChallengeMethod: ''
      };
    } else {
      challenge = OAuthChallenge.create();
    }

    var baseAuthUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
    var params = [
      'client_id=' + encodeURIComponent(clientId),
      'redirect_uri=' + encodeURIComponent(redirectUri),
      'response_type=code',
      'scope=' + encodeURIComponent('openid email profile'),
      'state=' + encodeURIComponent(challenge.state),
      'prompt=select_account',
      'access_type=online'
    ];

    if (challenge.nonce) {
      params.push('nonce=' + encodeURIComponent(challenge.nonce));
    }
    if (challenge.codeChallenge) {
      params.push('code_challenge=' + encodeURIComponent(challenge.codeChallenge));
      params.push('code_challenge_method=' + encodeURIComponent(challenge.codeChallengeMethod || 'S256'));
    }

    return baseAuthUrl + '?' + params.join('&');
  },

  /**
   * Validates an incoming OAuth callback request from doGet(e).
   * Atomically validates and consumes the associated challenge.
   *
   * @param {Object} params - Query parameters from doGet (e.parameter).
   * @returns {{
   *   valid: boolean,
   *   isError: boolean,
   *   errorCode?: string,
   *   errorMessage?: string,
   *   code?: string,
   *   challenge?: Object,
   *   challengeConsumed?: boolean
   * }}
   */
  validateCallback: function(params) {
    if (!params || typeof params !== 'object') {
      return {
        valid: false,
        isError: true,
        errorCode: 'invalid_request',
        errorMessage: 'Callback parameters are missing or malformed.'
      };
    }

    var state = params.state ? String(params.state).trim() : '';
    if (!state) {
      return {
        valid: false,
        isError: true,
        errorCode: 'missing_state',
        errorMessage: 'The OAuth state parameter is missing. Request rejected to prevent CSRF attacks.'
      };
    }

    // Atomically consume challenge
    var challenge = OAuthChallenge.consume(state);
    if (!challenge) {
      return {
        valid: false,
        isError: true,
        errorCode: 'invalid_state',
        errorMessage: 'The OAuth state parameter is invalid, expired, or already consumed. Request rejected to prevent CSRF and replay attacks.'
      };
    }

    // Case 1: Google OAuth error callback (e.g. user cancelled or denied access)
    if (params.error) {
      var rawError = String(params.error);
      var safeMessage = 'Google OAuth authorization was denied or cancelled.';
      if (rawError === 'access_denied') {
        safeMessage = 'Sign-in was cancelled or access was denied by the user.';
      }
      return {
        valid: false,
        isError: true,
        errorCode: rawError,
        errorMessage: safeMessage,
        challengeConsumed: true
      };
    }

    // Case 2: Success callback (authorization code received)
    var code = params.code ? String(params.code).trim() : '';
    if (!code) {
      return {
        valid: false,
        isError: true,
        errorCode: 'missing_code',
        errorMessage: 'Authorization code was not provided in the OAuth callback.'
      };
    }

    return {
      valid: true,
      isError: false,
      code: code,
      challenge: challenge
    };
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
