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

  // Case 1: OAuth Error return (user cancelled or Google OAuth error)
  if (params.error) {
    template.viewState = 'error';
    template.errorCode = String(params.error);
    template.errorMessage = params.error_description ?
      String(params.error_description) :
      'Google OAuth authorization was denied or returned an error (' + params.error + ').';
  }
  // Case 2: OAuth Success Callback return (authorization code received)
  else if (params.code) {
    var state = params.state || '';
    var isStateValid = AuthConfig.validateState(state);

    if (!isStateValid) {
      template.viewState = 'error';
      template.errorCode = 'invalid_state';
      template.errorMessage = 'The OAuth state parameter is missing, expired, or invalid. Request rejected to prevent CSRF and replay attacks.';
    } else {
      template.viewState = 'callback_success';
      template.codeReceived = true;
      template.stateValid = true;
      template.pocNotice = 'PoC Stage FFM-006: Authorization code received and state verified. Code exchange (FFM-008) and session creation (FFM-010) are scheduled for subsequent tasks. Access is not yet granted.';
    }
  }
  // Case 3: Initial Web App Visit (Login View)
  else {
    template.viewState = 'login';
    var stateToken = AuthConfig.createState();
    template.authUrl = AuthConfig.getAuthorizationUrl(stateToken);
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
 * @returns {{ authUrl: string, state: string }}
 */
function apiGetAuthUrl() {
  var state = AuthConfig.createState();
  return {
    authUrl: AuthConfig.getAuthorizationUrl(state),
    state: state
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
