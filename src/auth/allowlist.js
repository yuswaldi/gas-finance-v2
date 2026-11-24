/**
 * AuthAllowlist module
 * Implements strict server-side account allowlist authorization for Google identities.
 * Evaluates verified identities from FFM-008 against authorized accounts configured in Script Properties.
 */
var AuthAllowlist = {
  /**
   * Retrieves the configured allowlist from Script Properties.
   * Checks for ALLOWED_EMAILS (or AUTHORIZED_EMAILS / ALLOWLIST_EMAILS)
   * and ALLOWED_GOOGLE_SUBS (or AUTHORIZED_GOOGLE_SUBS / ALLOWLIST_GOOGLE_SUBS).
   *
   * @returns {{ emails: string[], googleSubs: string[] }} Parsed allowlist arrays.
   */
  getAllowlistConfig: function() {
    try {
      var props = PropertiesService.getScriptProperties();
      if (!props) {
        return { emails: [], googleSubs: [] };
      }

      var rawEmails = props.getProperty('ALLOWED_EMAILS') ||
                      props.getProperty('AUTHORIZED_EMAILS') ||
                      props.getProperty('ALLOWLIST_EMAILS') || '';

      var rawSubs = props.getProperty('ALLOWED_GOOGLE_SUBS') ||
                    props.getProperty('AUTHORIZED_GOOGLE_SUBS') ||
                    props.getProperty('ALLOWLIST_GOOGLE_SUBS') || '';

      var parseList = function(rawStr, isEmail) {
        if (!rawStr || typeof rawStr !== 'string') {
          return [];
        }
        // Split by commas, semicolons, or newlines
        var tokens = rawStr.split(/[,;\r\n]+/);
        var result = [];
        for (var i = 0; i < tokens.length; i++) {
          var item = tokens[i].trim();
          if (item) {
            if (isEmail) {
              item = item.toLowerCase();
              // Validate basic email format: must contain '@' not at start or end, and no spaces
              if (item.indexOf('@') <= 0 || item.indexOf('@') >= item.length - 1 || item.indexOf(' ') !== -1) {
                continue;
              }
            }
            result.push(item);
          }
        }
        return result;
      };

      return {
        emails: parseList(rawEmails, true),
        googleSubs: parseList(rawSubs, false)
      };
    } catch (err) {
      Logger.log('Warning: Unable to access Script Properties for Allowlist: ' + err.message);
      return { emails: [], googleSubs: [] };
    }
  },

  /**
   * Authorizes a verified Google identity against the server-side allowlist.
   * Fails closed if allowlist is missing, empty, or if the identity is not explicitly authorized.
   *
   * @param {Object} identity - Verified identity object from FFM-008.
   * @returns {{
   *   authorized: boolean,
   *   errorCode?: string,
   *   errorMessage?: string
   * }} Authorization decision.
   */
  authorize: function(identity) {
    if (!identity || typeof identity !== 'object') {
      return {
        authorized: false,
        errorCode: 'invalid_identity',
        errorMessage: 'This Google account is not authorized to access the application.'
      };
    }

    var config = this.getAllowlistConfig();
    var hasEmailConfig = config.emails.length > 0;
    var hasSubConfig = config.googleSubs.length > 0;

    // Fail closed if allowlist configuration is missing, empty, or unconfigured
    if (!hasEmailConfig && !hasSubConfig) {
      Logger.log('Security Warning: Account allowlist is unconfigured or empty. Failing closed.');
      return {
        authorized: false,
        errorCode: 'allowlist_unconfigured',
        errorMessage: 'This Google account is not authorized to access the application.'
      };
    }

    // 1. Check Google Subject (sub) allowlist if configured
    if (hasSubConfig) {
      var sub = identity.googleSub ? String(identity.googleSub).trim() : '';
      if (!sub && !hasEmailConfig) {
        Logger.log('Security Warning: Allowlist check denied missing googleSub.');
        return {
          authorized: false,
          errorCode: 'missing_google_sub',
          errorMessage: 'This Google account is not authorized to access the application.'
        };
      }
      if (sub) {
        for (var i = 0; i < config.googleSubs.length; i++) {
          if (config.googleSubs[i] === sub) {
            return { authorized: true };
          }
        }
      }
    }

    // 2. Check Email allowlist if configured
    if (hasEmailConfig) {
      // Require emailVerified === true
      if (identity.emailVerified !== true) {
        Logger.log('Security Warning: Allowlist check denied unverified email.');
        return {
          authorized: false,
          errorCode: 'unverified_email',
          errorMessage: 'This Google account is not authorized to access the application.'
        };
      }

      var email = identity.email ? String(identity.email).trim().toLowerCase() : '';
      if (!email || email.indexOf('@') === -1) {
        Logger.log('Security Warning: Allowlist check denied missing or invalid email.');
        return {
          authorized: false,
          errorCode: 'missing_email',
          errorMessage: 'This Google account is not authorized to access the application.'
        };
      }

      for (var j = 0; j < config.emails.length; j++) {
        // Exact, case-insensitive string match
        if (config.emails[j] === email) {
          return { authorized: true };
        }
      }
    }

    // Identity was not found in allowlist
    Logger.log('Notice: Unauthorized identity rejected by allowlist.');
    return {
      authorized: false,
      errorCode: 'unauthorized_account',
      errorMessage: 'This Google account is not authorized to access the application.'
    };
  }
};
