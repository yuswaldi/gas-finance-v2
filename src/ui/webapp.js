/* global HtmlService, AuthConfig */

/**
 * Web App entry point for HTTP GET requests.
 * Renders the HTMLService interface with public GIS configuration.
 *
 * @param {Object} _e - Event parameter from Google Apps Script GET request.
 * @returns {HtmlOutput} Evaluated HTML template.
 */
function doGet(_e) {
  var template;
  try {
    template = HtmlService.createTemplateFromFile('src/ui/index');
  } catch (_err) {
    // Fallback if Apps Script resolves template without path prefix
    template = HtmlService.createTemplateFromFile('index');
  }

  // Inject non-sensitive public configuration
  template.gisClientId = AuthConfig.getGisClientId();

  var output = template.evaluate();
  output.setTitle('Personal & Family Finance Manager (GIS PoC)');
  output.addMetaTag('viewport', 'width=device-width, initial-scale=1');
  output.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  return output;
}

/**
 * Public API endpoint callable via google.script.run to fetch public configuration.
 *
 * @returns {{ gisClientId: string }}
 */
function apiGetPublicConfig() {
  return AuthConfig.getPublicConfig();
}
