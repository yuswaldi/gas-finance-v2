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
   * Retrieves the configured Google OAuth 2.0 Web Client Secret.
   * Checks Script Properties for 'OAUTH_CLIENT_SECRET' or 'GOOGLE_OAUTH_CLIENT_SECRET'.
   * NEVER expose this value to the browser or log traces.
   *
   * @returns {string} The configured client secret, or empty string if not configured.
   */
  getClientSecret: function() {
    try {
      var props = PropertiesService.getScriptProperties();
      var secret = props.getProperty('OAUTH_CLIENT_SECRET') ||
                   props.getProperty('GOOGLE_OAUTH_CLIENT_SECRET') ||
                   props.getProperty('CLIENT_SECRET') ||
                   props.getProperty('GOOGLE_CLIENT_SECRET') ||
                   props.getProperty('GIS_CLIENT_SECRET') ||
                   props.getProperty('OAUTH_SECRET');
      return secret ? String(secret).trim() : '';
    } catch (err) {
      Logger.log('Warning: Unable to access Script Properties for Client Secret: ' + err.message);
      return '';
    }
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
    var opts = options || {};
    if (!opts.redirectUri) {
      opts.redirectUri = this.getRedirectUri();
    }
    return OAuthChallenge.create(opts);
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
        codeChallengeMethod: '',
        redirectUri: redirectUri
      };
    } else {
      challenge = OAuthChallenge.create({ redirectUri: redirectUri });
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
   * 1. Consumes the server-side challenge atomically using state.
   * 2. Exchanges the authorization code using PKCE code_verifier at Google's token endpoint.
   * 3. Verifies the ID token claims (iss, aud, azp, exp, iat, nonce, sub, email, email_verified).
   *
   * @param {Object} params - Query parameters from doGet (e.parameter).
   * @returns {{
   *   valid: boolean,
   *   isError: boolean,
   *   errorCode?: string,
   *   errorMessage?: string,
   *   code?: string,
   *   identity?: Object,
   *   notice?: string,
   *   challengeConsumed?: boolean
   * }} Callback handling outcome.
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

    // Atomically consume challenge (validates state, expires record, prevents replay)
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

    // Step A: Perform server-side authorization code exchange
    // Use the redirectUri from the original challenge if available, ensuring exact match
    var redirectUri = challenge.redirectUri || this.getRedirectUri();

    var exchangeResult = OAuthToken.exchangeCode({
      code: code,
      codeVerifier: challenge.codeVerifier,
      clientId: this.getClientId(),
      clientSecret: this.getClientSecret(),
      redirectUri: redirectUri
    });

    if (!exchangeResult.success) {
      var errCode = exchangeResult.error || 'exchange_failed';
      var errDesc = exchangeResult.errorDescription ? (' - ' + exchangeResult.errorDescription) : '';
      Logger.log('Notice: Token exchange unsuccessful for callback: ' + errCode + errDesc);
      return {
        valid: false,
        isError: true,
        errorCode: errCode,
        errorMessage: 'OAuth token exchange failed (' + errCode + errDesc + '). Please try signing in again.'
      };
    }

    // Step B: Verify the received ID token
    var verifyResult = OAuthToken.verifyIdToken({
      idToken: exchangeResult.idToken,
      expectedNonce: challenge.nonce,
      expectedClientId: this.getClientId()
    });

    if (!verifyResult.success) {
      return {
        valid: false,
        isError: true,
        errorCode: verifyResult.error || 'verification_failed',
        errorMessage: 'OpenID Connect identity verification failed: ' + (verifyResult.errorMessage || 'invalid claims') + '.'
      };
    }

    // Step C: Evaluate account allowlist authorization (FFM-009)
    var authResult = AuthAllowlist.authorize(verifyResult.identity);
    if (!authResult.authorized) {
      return {
        valid: false,
        isError: true,
        errorCode: authResult.errorCode || 'unauthorized_account',
        errorMessage: authResult.errorMessage || 'This Google account is not authorized to access the application.',
        accountAuthorized: false,
        identity: null
      };
    }

    // Step D: Create application session (FFM-010)
    var sessionResult = AuthSession.createSession(verifyResult.identity);
    if (!sessionResult.success) {
      Logger.log('Security Error: Failed to create application session: ' + sessionResult.errorMessage);
      return {
        valid: false,
        isError: true,
        errorCode: sessionResult.error || 'session_creation_failed',
        errorMessage: 'Failed to establish application session. Please try signing in again.',
        accountAuthorized: true,
        identity: null,
        session: null
      };
    }

    return {
      valid: true,
      isError: false,
      code: code,
      accountAuthorized: true,
      identity: verifyResult.identity,
      session: {
        token: sessionResult.token,
        sessionId: sessionResult.sessionId,
        expiresAt: sessionResult.expiresAt
      },
      notice: 'Google account authorized and application session established.'
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
