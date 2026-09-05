const API_HOST = "https://app.m2mservices.com/CommonAdministrationService/api/";
// All endpoints (auth, user settings, device/zone data, and arming) are v3, confirmed via a live
// capture of the iOS app's traffic.
export const API_URL = API_HOST + "v3/";
export const AUTH_TOKEN_HEADER_NAME = 'M2MOAuth2Token';

export const PLATFORM_NAME = "M2M";
export const PLUGIN_NAME = "homebridge-m2m";
