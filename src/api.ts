import { Logging } from "homebridge";
import fetch, { Headers } from "node-fetch";
import { API_URL, AUTH_TOKEN_HEADER_NAME } from "./settings";
import { CreateAuthCodePostResponse, CreateAccessTokenPostResponse, GetUserSettingsPostResponse, GetAllDeviceDataPostResponse, GetDeviceStatusDataPostResponse, GetMobileDevicesInfoPostResponse, UpdateArmStatusPostResponse } from "./types";

// The M2M server can take 15-40s to confirm an arm/disarm with the panel over its cellular
// connection, but it occasionally drops the connection without ever responding. node-fetch has
// no default timeout, so without this an arm/disarm request can hang indefinitely.
const REQUEST_TIMEOUT_MS = 60000;

export class M2MAPI {
    private logger: Logging;
    private headers: Headers;
    private cachedUserSettings: GetUserSettingsPostResponse | undefined;

    constructor(logger: Logging) {
        this.logger = logger;
        this.headers = new Headers();
        this.headers.set('Content-Type', 'application/json');
    }

    isLoggedIn = (): boolean => {
        return this.headers.has(AUTH_TOKEN_HEADER_NAME);
    }

    private fetchWithTimeout = (url: string, body: {}) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        return fetch(url, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: this.headers,
            signal: controller.signal
        }).finally(() => clearTimeout(timeout));
    }

    // Centralizes request/response logging for every call. Request/response bodies are logged at
    // debug level (enable Homebridge's debug mode to see them); HTTP failures, application-level
    // failures (HTTP 200 with Success: false in the body), and thrown errors (timeouts, aborts,
    // non-JSON responses) are always logged at error level - the API otherwise fails silently.
    private request = async <T>(label: string, url: string, body: Record<string, unknown>): Promise<T | undefined> => {
        const loggableBody = 'UserPass' in body ? { ...body, UserPass: '***' } : body;
        this.logger.debug(`[M2M] ${label} request: ${url} ${JSON.stringify(loggableBody)}`);
        try {
            const response = await this.fetchWithTimeout(url, body);
            const text = await response.text();
            this.logger.debug(`[M2M] ${label} response (${response.status}): ${text}`);
            if (!response.ok) {
                this.logger.error(`[M2M] ${label} failed with HTTP ${response.status} ${response.statusText}.`);
            }
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && parsed.Success === false) {
                const errorMessage = parsed.ErrorMsg ?? parsed.ErrorString ?? 'no error message provided';
                this.logger.error(`[M2M] ${label} was rejected: ErrorCode ${parsed.ErrorCode}, "${errorMessage}".`);
            }
            return parsed as T;
        } catch (error) {
            this.logger.error(`[M2M] ${label} request failed. Error: ${error}`);
            return undefined;
        }
    }

    private ensureLoggedIn = (label: string): boolean => {
        if (!this.isLoggedIn()) {
            this.logger.error(`[M2M] Cannot call ${label}: not logged in to M2M yet.`);
            return false;
        }
        return true;
    }

    login = async (username: string, password: string) => {
        const createAuthCodeResponse = await this.createAuthCode(username, password);
        const authCode = createAuthCodeResponse?.AuthCode;
        if (!authCode) {
            this.logger.error('[M2M] Login failed: no authorization code returned.');
            return;
        }

        const createAccessTokenResponse = await this.createAccessToken(authCode);
        const accessToken = createAccessTokenResponse?.AccessToken;
        if (!accessToken) {
            this.logger.error('[M2M] Login failed: no access token returned.');
            return;
        }

        this.headers.set(AUTH_TOKEN_HEADER_NAME, accessToken);
        this.logger.debug('[M2M] Login succeeded.');

        // v3's getalldevicedata and getdevicestatusdata both require UserID, which only
        // gethausersettings provides - fetch and cache it now so every caller can reuse it.
        await this.getUserSettings();
    }

    createAuthCode = async (username: string, password: string): Promise<CreateAuthCodePostResponse | undefined> => {
        const url = API_URL + 'createauthorizationcode';
        const body = {
            'AdminRequest': false,
            'UserName': username,
            'UserPass': password
        }
        return this.request<CreateAuthCodePostResponse>('createauthorizationcode', url, body);
    }

    createAccessToken = async (authCode: string): Promise<CreateAccessTokenPostResponse | undefined> => {
        const url = API_URL + 'createaccesstoken';
        const body = {
            'AuthCode': authCode
        }
        return this.request<CreateAccessTokenPostResponse>('createaccesstoken', url, body);
    }

    // Memoized: gethausersettings is called once from login() to seed UserID for every other v3
    // call, and callers that need the response later (e.g. to pick an IMEI) get the cached result
    // instead of hitting the network again.
    getUserSettings = async (): Promise<GetUserSettingsPostResponse | undefined> => {
        if (!this.ensureLoggedIn('gethausersettings')) return;
        if (this.cachedUserSettings !== undefined) return this.cachedUserSettings;

        const url = API_URL + 'gethausersettings';
        const response = await this.request<GetUserSettingsPostResponse>('gethausersettings', url, {});
        if (response?.Success) {
            this.cachedUserSettings = response;
        }
        return response;
    }

    // Used both to discover zones/names at startup and to fetch a partition's current DeviceState
    // (e.g. for the security system accessory's current-state poll).
    getAllDeviceData = async (body: Record<string, unknown>): Promise<GetAllDeviceDataPostResponse | undefined> => {
        if (!this.ensureLoggedIn('getalldevicedata')) return;
        const url = API_URL + 'getalldevicedata';
        return this.request<GetAllDeviceDataPostResponse>('getalldevicedata', url, body);
    }

    updateArmStatus = async (body: Record<string, unknown>): Promise<UpdateArmStatusPostResponse | undefined> => {
        if (!this.ensureLoggedIn('remotearm')) return;
        const url = API_URL + 'remotearm';
        return this.request<UpdateArmStatusPostResponse>('remotearm', url, body);
    }

    getDeviceStatusData = async (body: Record<string, unknown>): Promise<GetDeviceStatusDataPostResponse | undefined> => {
        if (!this.ensureLoggedIn('getdevicestatusdata')) return;
        const url = API_URL + 'getdevicestatusdata';
        return this.request<GetDeviceStatusDataPostResponse>('getdevicestatusdata', url, body);
    }

    // Only used by the config UI's panel picker, to show each panel's account-assigned label
    // (e.g. an address) instead of a bare IMEI.
    getMobileDevicesInfo = async (): Promise<GetMobileDevicesInfoPostResponse | undefined> => {
        if (!this.ensureLoggedIn('getmobiledevicesinfo')) return;
        const url = API_URL + 'getmobiledevicesinfo';
        return this.request<GetMobileDevicesInfoPostResponse>('getmobiledevicesinfo', url, { 'RequestVersion': 1 });
    }

}
