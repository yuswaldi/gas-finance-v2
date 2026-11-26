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
  template.householdAuthorized = false;
  template.userRole = '';
  template.householdId = '';
  template.householdName = '';
  template.authzErrorCode = '';
  template.authzErrorMessage = '';

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
      template.sessionEstablished = !!callbackResult.session;
      template.sessionId = callbackResult.session ? callbackResult.session.sessionId : '';
      template.sessionToken = callbackResult.session ? callbackResult.session.token : '';
      template.sessionExpiresAt = callbackResult.session ? callbackResult.session.expiresAt : '';
      template.userEmail = callbackResult.identity ? callbackResult.identity.email : '';

      if (typeof AuthAuthorization !== 'undefined' && callbackResult.session && callbackResult.session.token) {
        var authzResult = AuthAuthorization.authorizeRequest(callbackResult.session.token, 'household.view');
        if (authzResult.authorized && authzResult.context) {
          template.householdAuthorized = true;
          template.userRole = authzResult.context.role;
          template.householdId = authzResult.context.household.householdId;
          template.householdName = authzResult.context.household.householdName;
          template.pocNotice = 'PoC Stage FFM-012: Google account verified, authorized by allowlist, application session established, and household membership (' + authzResult.context.role + ') authorized with server-side RBAC and household data isolation.';
        } else {
          template.householdAuthorized = false;
          template.authzErrorCode = authzResult.errorCode || 'household_access_denied';
          template.authzErrorMessage = authzResult.errorMessage || 'You are not authorized to perform this operation.';
          template.pocNotice = 'PoC Stage FFM-012: Authentication succeeded through FFM-009/010, but household authorization (FFM-012) denied access [' + template.authzErrorCode + ']. No household data is exposed.';
        }
      } else {
        template.pocNotice = 'PoC Stage FFM-012: Google account verified, authorized by allowlist, and application session established.';
      }
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

/**
 * Public API endpoint callable via google.script.run to validate an application session token.
 * Validates the session token server-side and returns the authenticated user identity.
 *
 * @param {string} token - The raw application session token.
 * @returns {{
 *   authenticated: boolean,
 *   sessionId?: string,
 *   user?: { googleSub: string, email: string, name: string },
 *   expiresAt?: number,
 *   error?: string,
 *   errorMessage?: string
 * }}
 */
function apiValidateSession(token) {
  var result = AuthSession.validateSession(token);
  if (!result.valid) {
    return {
      authenticated: false,
      error: result.error || 'invalid_session',
      errorMessage: result.errorMessage || 'Session is invalid or expired.'
    };
  }
  return {
    authenticated: true,
    sessionId: result.sessionId,
    user: {
      googleSub: result.googleSub,
      email: result.email,
      name: result.name
    },
    expiresAt: result.expiresAt
  };
}

/**
 * Public API endpoint callable via google.script.run to log out the user and revoke the session.
 * Revokes the server-side session record and invalidates the session token.
 *
 * @param {string} token - The raw application session token.
 * @returns {{
 *   success: boolean,
 *   loggedOut: boolean,
 *   error?: string,
 *   errorMessage?: string
 * }}
 */
function apiLogout(token) {
  var result = AuthSession.revokeSession(token);
  if (!result.success) {
    return {
      success: false,
      loggedOut: false,
      error: result.error || 'logout_failed',
      errorMessage: result.errorMessage || 'Failed to complete server logout.'
    };
  }
  return {
    success: true,
    loggedOut: true
  };
}

/**
 * Public API endpoint callable via google.script.run to resolve the authenticated user's
 * household membership, role, and authorized household context (FFM-012).
 *
 * @param {string} token - Raw application session token.
 * @param {Object} [requestScope] - Optional request parameters to validate against household isolation.
 * @returns {{
 *   authorized: boolean,
 *   authenticated: boolean,
 *   actor?: { userId: string, email: string, name: string, role: string, membershipStatus: string },
 *   household?: { householdId: string, householdName: string, baseCurrency: string, timezone: string },
 *   role?: string,
 *   permissions?: string[],
 *   errorCode?: string,
 *   errorMessage?: string
 * }}
 */
function apiGetHouseholdContext(token, requestScope) {
  var result = AuthAuthorization.authorizeRequest(token, 'household.view', requestScope);
  if (!result.authorized) {
    return {
      authorized: false,
      authenticated: !!result.authenticated,
      errorCode: result.errorCode || 'household_access_denied',
      errorMessage: result.errorMessage || AuthAuthorization.SAFE_ERROR_MESSAGE
    };
  }

  return {
    authorized: true,
    authenticated: true,
    actor: {
      userId: result.context.actor.userId,
      email: result.context.actor.email,
      name: result.context.actor.name,
      role: result.context.actor.role,
      membershipStatus: result.context.actor.membershipStatus
    },
    household: {
      householdId: result.context.household.householdId,
      householdName: result.context.household.householdName,
      baseCurrency: result.context.household.baseCurrency,
      timezone: result.context.household.timezone
    },
    role: result.context.role,
    permissions: result.context.permissions.slice()
  };
}

/**
 * Public API endpoint callable via google.script.run to check whether the authenticated session
 * is authorized for a specific permission and request scope (FFM-012).
 *
 * @param {string} token - Raw application session token.
 * @param {string} permission - Required permission identifier.
 * @param {Object} [requestScope] - Optional request parameters or target resource scope.
 * @returns {{
 *   authorized: boolean,
 *   authenticated: boolean,
 *   role?: string,
 *   householdId?: string,
 *   permission?: string,
 *   errorCode?: string,
 *   errorMessage?: string
 * }}
 */
function apiAuthorizeOperation(token, permission, requestScope) {
  var result = AuthAuthorization.authorizeRequest(token, permission, requestScope);
  if (!result.authorized) {
    return {
      authorized: false,
      authenticated: !!result.authenticated,
      errorCode: result.errorCode || 'permission_denied',
      errorMessage: result.errorMessage || AuthAuthorization.SAFE_ERROR_MESSAGE
    };
  }

  return {
    authorized: true,
    authenticated: true,
    role: result.context.role,
    householdId: result.context.household.householdId,
    permission: permission
  };
}
