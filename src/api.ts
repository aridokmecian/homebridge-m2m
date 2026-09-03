import { Logging } from "homebridge";
import fetch, { Headers } from "node-fetch";
import { API_URL, API_URL_V3, AUTH_TOKEN_HEADER_NAME } from "./settings";
import { CreateAuthCodePostResponse, CreateAccessTokenPostResponse, GetUserSettingsPostResponse, GetAllDeviceDataPostResponse, UpdateArmStatusPostResponse } from "./types";

// RControl's server can take 15-40s to confirm an arm/disarm with the panel over its cellular
// connection, but it occasionally drops the connection without ever responding. node-fetch has
// no default timeout, so without this an arm/disarm request can hang indefinitely.
const REQUEST_TIMEOUT_MS = 60000;

export class RControlAPI {
    private logger: Logging;
    private headers: Headers;

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
    // debug level (enable Homebridge's debug mode to see them); HTTP failures and thrown errors
    // (timeouts, aborts, non-JSON responses) are always logged at error level.
    private request = async <T>(label: string, url: string, body: Record<string, unknown>): Promise<T | undefined> => {
        const loggableBody = 'UserPass' in body ? { ...body, UserPass: '***' } : body;
        this.logger.debug(`[RControl] ${label} request: ${url} ${JSON.stringify(loggableBody)}`);
        try {
            const response = await this.fetchWithTimeout(url, body);
            const text = await response.text();
            this.logger.debug(`[RControl] ${label} response (${response.status}): ${text}`);
            if (!response.ok) {
                this.logger.error(`[RControl] ${label} failed with HTTP ${response.status} ${response.statusText}.`);
            }
            return JSON.parse(text) as T;
        } catch (error) {
            this.logger.error(`[RControl] ${label} request failed. Error: ${error}`);
            return undefined;
        }
    }

    private ensureLoggedIn = (label: string): boolean => {
        if (!this.isLoggedIn()) {
            this.logger.error(`[RControl] Cannot call ${label}: not logged in to RControl yet.`);
            return false;
        }
        return true;
    }

    login = async (username: string, password: string) => {
        const createAuthCodeResponse = await this.createAuthCode(username, password);
        const authCode = createAuthCodeResponse?.AuthCode;
        if (!authCode) {
            this.logger.error(`[RControl] Login failed: no authorization code returned. Response: ${JSON.stringify(createAuthCodeResponse)}`);
            return;
        }

        const createAccessTokenResponse = await this.createAccessToken(authCode);
        const accessToken = createAccessTokenResponse?.AccessToken;
        if (!accessToken) {
            this.logger.error(`[RControl] Login failed: no access token returned. Response: ${JSON.stringify(createAccessTokenResponse)}`);
            return;
        }

        this.headers.set(AUTH_TOKEN_HEADER_NAME, accessToken);
        this.logger.debug('[RControl] Login succeeded.');
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
            'AuthCode': authCode,
        }
        return this.request<CreateAccessTokenPostResponse>('createaccesstoken', url, body);
    }

    getUserSettings = async (): Promise<GetUserSettingsPostResponse | undefined> => {
        if (!this.ensureLoggedIn('gethausersettings')) return;
        const url = API_URL + 'gethausersettings';
        return this.request<GetUserSettingsPostResponse>('gethausersettings', url, {});
    }

    getAllDeviceData = async (body: Record<string, unknown>): Promise<GetAllDeviceDataPostResponse | undefined> => {
        if (!this.ensureLoggedIn('getalldevicedata')) return;
        const url = API_URL + 'getalldevicedata';
        return this.request<GetAllDeviceDataPostResponse>('getalldevicedata', url, body);
    }

    updateArmStatus = async (body: Record<string, unknown>): Promise<UpdateArmStatusPostResponse | undefined> => {
        if (!this.ensureLoggedIn('remotearm')) return;
        const url = API_URL_V3 + 'remotearm';
        return this.request<UpdateArmStatusPostResponse>('remotearm', url, body);
    }

}
