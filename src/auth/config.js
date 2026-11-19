/**
 * AuthConfig module
 * Manages configuration resolution for Google Identity Services (GIS).
 */
var AuthConfig = {
  /**
   * Retrieves the configured Google Identity Services (GIS) Web Client ID.
   * Checks Script Properties for 'GIS_CLIENT_ID' or 'GOOGLE_OAUTH_CLIENT_ID'.
   *
   * @returns {string} The configured client ID, or empty string if not configured.
   */
  getGisClientId: function() {
    try {
      var props = PropertiesService.getScriptProperties();
      var clientId = props.getProperty('GIS_CLIENT_ID') || props.getProperty('GOOGLE_OAUTH_CLIENT_ID');
      return clientId ? String(clientId).trim() : '';
    } catch (err) {
      Logger.log('Warning: Unable to access Script Properties: ' + err.message);
      return '';
    }
  },

  /**
   * Returns safe public configuration for frontend consumption.
   * NEVER include client secrets, private keys, or internal credentials here.
   *
   * @returns {{ gisClientId: string }}
   */
  getPublicConfig: function() {
    return {
      gisClientId: this.getGisClientId()
    };
  }
};
