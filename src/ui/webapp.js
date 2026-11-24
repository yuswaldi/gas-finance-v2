/**
 * Web App entry point for HTTP GET requests.
 * Renders the HTMLService interface for Google OAuth 2.0 Authorization Code Flow.
 *
 * @param {Object} e - Event parameter from Google Apps Script GET request.
 * @returns {HtmlOutput} Evaluated HTML template.
 */
function doGet(e) {
  var template;
  try {
    template = HtmlService.createTemplateFromFile('src/ui/index');
  } catch (_err) {
    // Fallback if Apps Script resolves template without path prefix
    template = HtmlService.createTemplateFromFile('index');
  }

  var params = (e && e.parameter) ? e.parameter : {};

  // Case 1: OAuth Callback return (success code, Google OAuth error, or callback with state)
  if (params.code || params.error || params.state) {
    var callbackResult = AuthConfig.validateCallback(params);
    if (!callbackResult.valid) {
      template.viewState = 'error';
      template.errorCode = callbackResult.errorCode || 'oauth_error';
      template.errorMessage = callbackResult.errorMessage || 'An error occurred during authentication.';
    } else {
      template.viewState = 'callback_success';
      template.codeReceived = true;
      template.challengeVerified = true;
      template.identityVerified = true;
      template.accountAuthorized = true;
      template.userEmail = callbackResult.identity ? callbackResult.identity.email : '';
      template.pocNotice = 'PoC Stage FFM-009: Google account verified and authorized by allowlist. Application session creation is scheduled for FFM-010. Access to household finance data is not yet granted.';
    }
  }
  // Case 2: Initial Web App Visit (Login View)
  else {
    template.viewState = 'login';
    var redirectUri = AuthConfig.getRedirectUri();
    var challenge = OAuthChallenge.create({ redirectUri: redirectUri });
    template.authUrl = AuthConfig.getAuthorizationUrl(challenge);
  }

  // Common template variables
  template.clientId = AuthConfig.getClientId();
  template.redirectUri = AuthConfig.getRedirectUri();
  template.clientIdConfigured = !!template.clientId;
  template.redirectUriConfigured = !!template.redirectUri;

  var output = template.evaluate();
  output.setTitle('Personal & Family Finance Manager (OAuth PoC)');
  output.addMetaTag('viewport', 'width=device-width, initial-scale=1');
  output.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  return output;
}

/**
 * Public API endpoint callable via google.script.run to dynamically fetch a fresh authorization URL.
 *
 * @returns {{ authUrl: string }}
 */
function apiGetAuthUrl() {
  var redirectUri = AuthConfig.getRedirectUri();
  var challenge = OAuthChallenge.create({ redirectUri: redirectUri });
  return {
    authUrl: AuthConfig.getAuthorizationUrl(challenge)
  };
}

/**
 * Public API endpoint callable via google.script.run to fetch public configuration.
 *
 * @returns {{ clientId: string, redirectUri: string }}
 */
function apiGetPublicConfig() {
  return AuthConfig.getPublicConfig();
}
