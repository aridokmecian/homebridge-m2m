const API_HOST = "https://app.m2mservices.com/CommonAdministrationService/api/";
export const API_URL = API_HOST + "v2/";
// The remotearm endpoint moved to v3 (confirmed via a live capture of the iOS app's traffic);
// other endpoints haven't been confirmed on v3 so they stay on v2, except for the zone endpoints
// below, which the app only calls on v3.
export const API_URL_V3 = API_HOST + "v3/";
export const AUTH_TOKEN_HEADER_NAME = 'M2MOAuth2Token';

export const PLATFORM_NAME = "RControl";
export const PLUGIN_NAME = "homebridge-m2m";