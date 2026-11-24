/**
 * OAuthToken module
 * Handles server-side authorization code exchange and OpenID Connect (OIDC) ID token verification
 * for Google OAuth 2.0 Authorization Code Flow.
 */
var OAuthToken = {
  /**
   * Google OAuth 2.0 token endpoint.
   */
  TOKEN_ENDPOINT: 'https://oauth2.googleapis.com/token',

  /**
   * Accepted Google token issuer identifiers per OpenID Connect Discovery.
   */
  ACCEPTED_ISSUERS: [
    'https://accounts.google.com',
    'accounts.google.com'
  ],

  /**
   * Clock skew tolerance in seconds for token timestamp verification.
   */
  CLOCK_SKEW_SECONDS: 60,

  /**
   * Maximum acceptable token age in seconds from issuance (10 minutes).
   */
  MAX_TOKEN_AGE_SECONDS: 600,

  /**
   * Safely decodes a Base64URL-encoded UTF-8 string without external dependencies.
   *
   * @param {string} input - Base64URL-encoded string.
   * @returns {string} Decoded UTF-8 string.
   */
  base64UrlDecode: function(input) {
    if (!input || typeof input !== 'string') {
      throw new Error('Invalid Base64URL string');
    }
    // Replace URL-safe characters with standard Base64 characters
    var base64 = input.replace(/-/g, '+').replace(/_/g, '/');
    // Add required padding characters '='
    var padLength = (4 - (base64.length % 4)) % 4;
    for (var i = 0; i < padLength; i++) {
      base64 += '=';
    }
    var decodedBytes = Utilities.base64Decode(base64, Utilities.Charset.UTF_8);
    return Utilities.newBlob(decodedBytes).getDataAsString('UTF-8');
  },

  /**
   * Parses and validates the structural components of a JSON Web Token (JWT).
   *
   * @param {string} jwtString - Raw JWT string (header.payload.signature).
   * @returns {{ header: Object, payload: Object, signature: string }} Decoded components.
   */
  decodeJwt: function(jwtString) {
    if (!jwtString || typeof jwtString !== 'string') {
      throw new Error('JWT must be a non-empty string');
    }
    var parts = jwtString.trim().split('.');
    if (parts.length !== 3) {
      throw new Error('JWT must have exactly three dot-separated components');
    }
    if (!parts[0] || !parts[1] || !parts[2]) {
      throw new Error('JWT components must not be empty');
    }

    var headerJson = this.base64UrlDecode(parts[0]);
    var payloadJson = this.base64UrlDecode(parts[1]);

    var header;
    var payload;
    try {
      header = JSON.parse(headerJson);
    } catch (_err) {
      throw new Error('Malformed JWT header JSON');
    }
    try {
      payload = JSON.parse(payloadJson);
    } catch (_err2) {
      throw new Error('Malformed JWT payload JSON');
    }

    return {
      header: header,
      payload: payload,
      signature: parts[2]
    };
  },

  /**
   * Exchanges an authorization code for tokens at Google's token endpoint.
   * Sends code, code_verifier, client_id, client_secret (if configured), and redirect_uri.
   *
   * @param {Object} params - Exchange parameters.
   * @param {string} params.code - Authorization code received from OAuth callback.
   * @param {string} params.codeVerifier - High-entropy PKCE verifier from server challenge.
   * @param {string} params.clientId - Configured Google OAuth Web Client ID.
   * @param {string} [params.clientSecret] - Configured Google OAuth Web Client Secret (if confidential).
   * @param {string} params.redirectUri - Original redirect URI used in authorization request.
   * @returns {{
   *   success: boolean,
   *   idToken?: string,
   *   error?: string,
   *   errorDescription?: string
   * }} Result of the token exchange.
   */
  exchangeCode: function(params) {
    if (!params || typeof params !== 'object') {
      return { success: false, error: 'invalid_params', errorDescription: 'Missing exchange parameters' };
    }
    if (!params.code || typeof params.code !== 'string' || !params.code.trim()) {
      return { success: false, error: 'missing_code', errorDescription: 'Authorization code is required' };
    }
    if (!params.codeVerifier || typeof params.codeVerifier !== 'string' || !params.codeVerifier.trim()) {
      return { success: false, error: 'missing_code_verifier', errorDescription: 'PKCE code_verifier is required' };
    }
    if (!params.clientId || typeof params.clientId !== 'string' || !params.clientId.trim()) {
      return { success: false, error: 'missing_client_id', errorDescription: 'Client ID is required' };
    }
    if (!params.redirectUri || typeof params.redirectUri !== 'string' || !params.redirectUri.trim()) {
      return { success: false, error: 'missing_redirect_uri', errorDescription: 'Redirect URI is required' };
    }

    var formFields = {
      code: params.code.trim(),
      client_id: params.clientId.trim(),
      redirect_uri: params.redirectUri.trim(),
      grant_type: 'authorization_code',
      code_verifier: params.codeVerifier.trim()
    };
    if (params.clientSecret && typeof params.clientSecret === 'string' && params.clientSecret.trim()) {
      formFields.client_secret = params.clientSecret.trim();
    } else {
      Logger.log('Warning: client_secret is missing or empty. Google OAuth Web Client requires a valid client_secret in Script Properties.');
    }

    var payloadParts = [];
    for (var key in formFields) {
      if (Object.prototype.hasOwnProperty.call(formFields, key)) {
        payloadParts.push(encodeURIComponent(key) + '=' + encodeURIComponent(formFields[key]));
      }
    }
    var payloadBody = payloadParts.join('&');

    var fetchOptions = {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      payload: payloadBody,
      muteHttpExceptions: true,
      followRedirects: false,
      validateHttpsCertificates: true
    };

    try {
      var response = UrlFetchApp.fetch(this.TOKEN_ENDPOINT, fetchOptions);
      var statusCode = response.getResponseCode();
      var responseText = response.getContentText();

      var responseData = {};
      try {
        responseData = JSON.parse(responseText);
      } catch (_jsonErr) {
        responseData = {};
      }

      if (statusCode !== 200) {
        var errCode = responseData.error || ('http_' + statusCode);
        var errDesc = responseData.error_description || ('HTTP status ' + statusCode);
        Logger.log('Warning: Google OAuth token exchange failed with HTTP status ' + statusCode + ': error="' + errCode + '", error_description="' + errDesc + '"');
        return {
          success: false,
          error: String(errCode),
          errorDescription: String(errDesc)
        };
      }

      var idToken = responseData.id_token;
      if (!idToken || typeof idToken !== 'string' || !idToken.trim()) {
        Logger.log('Warning: Google token response did not contain an id_token');
        return {
          success: false,
          error: 'missing_id_token',
          errorDescription: 'Token response did not contain an id_token'
        };
      }

      // Successful exchange: return strictly the ID token
      // Do not store, persist, or expose access_token or refresh_token
      return {
        success: true,
        idToken: idToken.trim()
      };
    } catch (fetchErr) {
      Logger.log('Error during token endpoint request: ' + fetchErr.message);
      return {
        success: false,
        error: 'network_error',
        errorDescription: 'Failed to communicate with Google token endpoint: ' + fetchErr.message
      };
    }
  },

  /**
   * Verifies an ID token received directly from Google's token endpoint.
   * Validates structure, algorithm, claims, expiration, audience, and nonce.
   *
   * @param {Object} params - Verification parameters.
   * @param {string} params.idToken - Raw ID token JWT string.
   * @param {string} params.expectedNonce - One-time nonce from the consumed challenge.
   * @param {string} params.expectedClientId - Configured Google OAuth Web Client ID.
   * @returns {{
   *   success: boolean,
   *   identity?: {
   *     googleSub: string,
   *     email: string,
   *     emailVerified: boolean,
   *     name: string,
   *     picture: string,
   *     issuedAt: number,
   *     expiresAt: number,
   *     verifiedAt: number
   *   },
   *   error?: string,
   *   errorMessage?: string
   * }} Verification outcome.
   */
  verifyIdToken: function(params) {
    if (!params || typeof params !== 'object') {
      return { success: false, error: 'invalid_params', errorMessage: 'Missing verification parameters' };
    }
    if (!params.idToken || typeof params.idToken !== 'string' || !params.idToken.trim()) {
      return { success: false, error: 'missing_id_token', errorMessage: 'ID token is missing or empty' };
    }
    if (!params.expectedNonce || typeof params.expectedNonce !== 'string' || !params.expectedNonce.trim()) {
      return { success: false, error: 'missing_expected_nonce', errorMessage: 'Expected challenge nonce is required' };
    }
    if (!params.expectedClientId || typeof params.expectedClientId !== 'string' || !params.expectedClientId.trim()) {
      return { success: false, error: 'missing_expected_client_id', errorMessage: 'Expected Client ID is required' };
    }

    var decoded;
    try {
      decoded = this.decodeJwt(params.idToken);
    } catch (decodeErr) {
      return { success: false, error: 'malformed_jwt', errorMessage: decodeErr.message };
    }

    var header = decoded.header;
    var payload = decoded.payload;

    // 1. Validate Header
    if (!header || typeof header !== 'object') {
      return { success: false, error: 'malformed_header', errorMessage: 'Invalid JWT header' };
    }
    if (header.alg !== 'RS256') {
      return { success: false, error: 'unsupported_algorithm', errorMessage: 'Unsupported JWT algorithm: ' + header.alg };
    }
    if (header.typ && header.typ !== 'JWT') {
      return { success: false, error: 'invalid_token_type', errorMessage: 'Invalid token type: ' + header.typ };
    }
    if (!header.kid || typeof header.kid !== 'string' || !header.kid.trim()) {
      return { success: false, error: 'missing_kid', errorMessage: 'JWT header is missing key ID (kid)' };
    }

    // 2. Validate Issuer (iss)
    if (!payload.iss || typeof payload.iss !== 'string') {
      return { success: false, error: 'missing_issuer', errorMessage: 'ID token is missing issuer (iss)' };
    }
    var isValidIssuer = false;
    for (var i = 0; i < this.ACCEPTED_ISSUERS.length; i++) {
      if (payload.iss === this.ACCEPTED_ISSUERS[i]) {
        isValidIssuer = true;
        break;
      }
    }
    if (!isValidIssuer) {
      return { success: false, error: 'invalid_issuer', errorMessage: 'Untrusted token issuer: ' + payload.iss };
    }

    // 3. Validate Audience (aud)
    if (!payload.aud || typeof payload.aud !== 'string') {
      return { success: false, error: 'missing_audience', errorMessage: 'ID token is missing audience (aud)' };
    }
    if (payload.aud !== params.expectedClientId.trim()) {
      return { success: false, error: 'invalid_audience', errorMessage: 'Token audience does not match configured Client ID' };
    }

    // 4. Validate Authorized Party (azp), if present
    if (payload.azp) {
      if (typeof payload.azp !== 'string' || payload.azp !== params.expectedClientId.trim()) {
        return { success: false, error: 'invalid_authorized_party', errorMessage: 'Token azp does not match configured Client ID' };
      }
    }

    var nowSeconds = Math.floor(Date.now() / 1000);

    // 5. Validate Expiration Time (exp)
    if (typeof payload.exp !== 'number' || isNaN(payload.exp)) {
      return { success: false, error: 'missing_exp', errorMessage: 'ID token is missing expiration timestamp (exp)' };
    }
    if (nowSeconds > (payload.exp + this.CLOCK_SKEW_SECONDS)) {
      return { success: false, error: 'token_expired', errorMessage: 'ID token has expired' };
    }

    // 6. Validate Issued At (iat)
    if (typeof payload.iat !== 'number' || isNaN(payload.iat)) {
      return { success: false, error: 'missing_iat', errorMessage: 'ID token is missing issued-at timestamp (iat)' };
    }
    if (payload.iat > (nowSeconds + this.CLOCK_SKEW_SECONDS)) {
      return { success: false, error: 'token_issued_in_future', errorMessage: 'ID token issued-at timestamp is in the future' };
    }
    if ((nowSeconds - payload.iat) > this.MAX_TOKEN_AGE_SECONDS) {
      return { success: false, error: 'token_too_old', errorMessage: 'ID token exceeds maximum acceptable age' };
    }

    // 7. Validate Nonce
    if (!payload.nonce || typeof payload.nonce !== 'string') {
      return { success: false, error: 'missing_nonce', errorMessage: 'ID token is missing nonce claim' };
    }
    if (payload.nonce !== params.expectedNonce.trim()) {
      return { success: false, error: 'nonce_mismatch', errorMessage: 'Token nonce does not match server-issued challenge nonce' };
    }

    // 8. Validate Subject (sub)
    if (!payload.sub || typeof payload.sub !== 'string' || !payload.sub.trim()) {
      return { success: false, error: 'missing_sub', errorMessage: 'ID token is missing subject identity (sub)' };
    }

    // 9. Validate Email and Email Verification
    if (!payload.email || typeof payload.email !== 'string' || payload.email.indexOf('@') === -1) {
      return { success: false, error: 'missing_email', errorMessage: 'ID token is missing valid email claim' };
    }
    if (payload.email_verified !== true) {
      return { success: false, error: 'unverified_email', errorMessage: 'Google account email is not verified' };
    }

    // Return sanitized verified identity object
    // Contains strictly validated claims; no tokens, secrets, or internal verifiers
    var identity = {
      googleSub: String(payload.sub).trim(),
      email: String(payload.email).trim().toLowerCase(),
      emailVerified: true,
      name: payload.name ? String(payload.name).trim() : '',
      picture: payload.picture ? String(payload.picture).trim() : '',
      issuedAt: payload.iat,
      expiresAt: payload.exp,
      verifiedAt: nowSeconds
    };

    return {
      success: true,
      identity: identity
    };
  }
};
