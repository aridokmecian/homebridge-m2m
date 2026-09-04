import { AccessoryConfig, AccessoryPlugin, API, CharacteristicEventTypes, CharacteristicGetCallback, CharacteristicSetCallback, CharacteristicValue, HAP, Logging, Service} from "homebridge";
import { ServerAlarmState, DeviceState, Options, GetUserSettingsPostResponse, GetAllDeviceDataPostResponse } from "./types";
import { RControlAPI } from "./api";

export = (api: API) => {
    api.registerAccessory("RControl", RControl);
};

class RControl implements AccessoryPlugin {

    private readonly logger: Logging;
    private readonly config: Options;
    private readonly service: Service;
    private readonly informationService: Service;
    private readonly hap: HAP;
    private readonly rcontrolApi: RControlAPI

    private lastUserSettingsResponse: GetUserSettingsPostResponse | undefined = undefined;
    private lastDeviceDataResponse: GetAllDeviceDataPostResponse | undefined = undefined;
    private targetState: CharacteristicValue | undefined = undefined;
    private lastKnownState: CharacteristicValue | undefined = undefined;

    constructor(logger: Logging, config: AccessoryConfig, api: API) {
        this.hap = api.hap;
        this.logger = logger;

        this.config = {
            name: config.name as string,
            username: config.username as string,
            password: config.password as string
        };

        this.service = new this.hap.Service.SecuritySystem(config.name);
        this.rcontrolApi = new RControlAPI(logger);

        this.service.getCharacteristic(this.hap.Characteristic.SecuritySystemCurrentState)
            .on(CharacteristicEventTypes.GET, this.handleSecuritySystemCurrentStateGet.bind(this));

        this.service.getCharacteristic(this.hap.Characteristic.SecuritySystemTargetState)
            .on(CharacteristicEventTypes.GET, this.handleSecuritySystemTargetStateGet.bind(this))
            .on(CharacteristicEventTypes.SET, this.handleSecuritySystemTargetStateSet.bind(this));

        this.informationService = new this.hap.Service.AccessoryInformation();

        if (!this.config.username || !this.config.password) {
            this.logger.error("No RControl credentials provided.");
        } else {
            this.rcontrolApi.login(this.config.username, this.config.password);
        }
    }

    handleSecuritySystemCurrentStateGet(callback: CharacteristicGetCallback) {
        // Fetching state from RControl's cloud can take several seconds, which is enough to trip
        // Homebridge's "slow to respond" warning if we make HomeKit wait on it. Answer from the
        // last known state when we have one, and refresh it in the background instead.
        if (this.lastKnownState !== undefined) {
            callback(null, this.lastKnownState);
            this.refreshAlarmState();
            return;
        }
        this.refreshAlarmState().then(state => {
            if (state === undefined) {
                callback(new Error('Failed to fetch current alarm state from RControl.'));
            } else {
                callback(null, state);
            }
        });
    }

    handleSecuritySystemTargetStateGet(callback: CharacteristicGetCallback) {
        if (this.targetState !== undefined) {
            callback(null, this.targetState);
            return;
        }
        if (this.lastKnownState !== undefined) {
            this.targetState = this.lastKnownState;
            callback(null, this.lastKnownState);
            return;
        }
        this.refreshAlarmState().then(state => {
            if (state === undefined) {
                callback(new Error('Failed to fetch current alarm state from RControl.'));
            } else {
                callback(null, state);
            }
        });
    }

    handleSecuritySystemTargetStateSet(value: CharacteristicValue, callback: CharacteristicSetCallback) {
        const targetServerState = this.hapStateToServerState(value);
        this.logger.info(`[RControl] Target state change requested: ${this.hapStateLabel(this.targetState)} -> ${this.hapStateLabel(value)}`);

        // Home and Night both arm RControl in the same "stay" mode, which the panel doesn't
        // distinguish. If we're already stay-armed, switching between Home and Night is a
        // local-only change; skip hitting RControl and just reflect the new HAP state.
        const previousServerState = this.targetState !== undefined ? this.hapStateToServerState(this.targetState) : undefined;
        if (targetServerState === ServerAlarmState.STAY && previousServerState === ServerAlarmState.STAY) {
            this.logger.info(`[RControl] ${this.hapStateLabel(this.targetState)} -> ${this.hapStateLabel(value)} is a Home/Night-only change; not contacting RControl.`);
            this.targetState = value;
            this.lastKnownState = value;
            this.service.getCharacteristic(this.hap.Characteristic.SecuritySystemCurrentState).updateValue(value);
            callback();
            return;
        }

        // RControl's API only supports arming from a disarmed state; it rejects a direct switch
        // between away-armed and stay-armed. The Home app lets the user do that switch directly
        // from its buttons, so when it happens we disarm first and then arm into the requested
        // state on RControl's behalf.
        const needsDisarmFirst = previousServerState !== undefined
            && previousServerState !== ServerAlarmState.DISARMED
            && targetServerState !== ServerAlarmState.DISARMED
            && previousServerState !== targetServerState;

        let armSequence;
        if (needsDisarmFirst) {
            this.logger.info(`[RControl] Disarming before switching from ${this.hapStateLabel(this.targetState)} to ${this.hapStateLabel(value)}...`);
            armSequence = this.updateAlarmState(ServerAlarmState.DISARMED).then(disarmResponse => {
                if (disarmResponse?.ErrorCode !== 0) {
                    this.logger.error('[RControl] Failed to disarm before switching arming mode; skipping re-arm.');
                    return disarmResponse;
                }
                this.logger.info(`[RControl] Disarmed; now arming to ${this.hapStateLabel(value)}...`);
                return this.updateAlarmState(targetServerState);
            });
        } else {
            armSequence = this.updateAlarmState(targetServerState);
        }

        armSequence
            .then(() => this.refreshAlarmState())
            .then(() => callback());
    }

    // Fetches the current alarm state, caches it, and pushes it to the CurrentState/TargetState
    // characteristics so HomeKit picks it up even when nothing was actively waiting on this call.
    refreshAlarmState = (): Promise<CharacteristicValue | undefined> => {
        return this.getCurrentAlarmState().then(state => {
            if (state !== undefined) {
                if (state !== this.lastKnownState) {
                    this.logger.info(`[RControl] Current state changed: ${this.hapStateLabel(this.lastKnownState)} -> ${this.hapStateLabel(state)}`);
                }
                this.lastKnownState = state;
                this.targetState = state;
                this.service.getCharacteristic(this.hap.Characteristic.SecuritySystemCurrentState).updateValue(state);
            }
            return state;
        });
    }

    hapStateLabel = (state: CharacteristicValue | undefined): string => {
        switch (state) {
            case this.hap.Characteristic.SecuritySystemTargetState.STAY_ARM: return 'Home';
            case this.hap.Characteristic.SecuritySystemTargetState.AWAY_ARM: return 'Away';
            case this.hap.Characteristic.SecuritySystemTargetState.NIGHT_ARM: return 'Night';
            case this.hap.Characteristic.SecuritySystemTargetState.DISARM: return 'Disarmed';
            case undefined: return 'unknown';
            default: return `unknown(${state})`;
        }
    }

    getCurrentAlarmState = async (): Promise<CharacteristicValue | undefined> => {
        if (this.lastUserSettingsResponse === undefined) { // We haven't fetched user settings yet
            const userSettingsResponse = await this.rcontrolApi.getUserSettings();
            if (userSettingsResponse === undefined) return;

            if (userSettingsResponse.HAUserSettings.AlarmIMEIUserNumbers.length === 0) {
                this.logger.error('Failed to fetch alarm state: the provided credentials have no alarms in the account.');
            } else {
                this.lastUserSettingsResponse = userSettingsResponse;
            }
        }

        if (this.lastUserSettingsResponse === undefined) return;
        const body = {
            // The following is what the API expects (as per the iOS app)
            'IMEI': this.lastUserSettingsResponse.HAUserSettings.AlarmIMEIUserNumbers[0].IMEI,
            'UserID': this.lastUserSettingsResponse.HAUserSettings.ID,
            'SerialNumber': '',
            'ReturnCamerasData': true,
            'ProtocolNumber': 4
        }
        const deviceDataResponse = await this.rcontrolApi.getAllDeviceData(body);
        if (deviceDataResponse?.AlarmControlSettingsV2Response.ExternalDevices.length === 0) {
            this.logger.error('Failed to fetch alarm state: the provided credentials have no external devices in the account.');
        } else {
            this.lastDeviceDataResponse = deviceDataResponse;
        }
        const deviceState = deviceDataResponse?.AlarmControlSettingsV2Response.ExternalDevices[0].DeviceState;
        return deviceState !== undefined ? this.deviceStateToHapState(deviceState) : undefined;
    }

    updateAlarmState = async (newState: ServerAlarmState) => {
        if (this.lastUserSettingsResponse === undefined || this.lastDeviceDataResponse === undefined) return;
        // The following is what the v3 API expects, confirmed via a live capture of the iOS
        // app's traffic. UserPIN is the literal string "EMPTY" when arming and is omitted
        // entirely when disarming; UserNumber is always sent empty.
        const body: { [key: string]: unknown } = {
            'IMEI': this.lastUserSettingsResponse.HAUserSettings.AlarmIMEIUserNumbers[0].IMEI,
            'UserNumber': '',
            'ArmingState': newState,
            'SerialNumber': this.lastDeviceDataResponse.AlarmControlSettingsV2Response.SerialNumber,
            'ProtocolNumber': 5,
            'OutPIN': String(this.lastDeviceDataResponse.AlarmControlSettingsV2Response.ExternalDevices[0].DevicePIN),
            'PartitionNumber': this.lastDeviceDataResponse.AlarmControlSettingsV2Response.ExternalDevices[0].PartitionNumber
        }
        if (newState !== ServerAlarmState.DISARMED) {
            body['UserPIN'] = 'EMPTY';
        }

        // The panel occasionally fails to confirm the state change back to RControl's server on
        // the first try (ErrorCode -2038, "NOT CONFIRMED") even though the command went through;
        // retrying once has been reliable.
        const NOT_CONFIRMED_ERROR_CODE = -2038;
        const MAX_ATTEMPTS = 5;
        let response;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            response = await this.rcontrolApi.updateArmStatus(body);
            if (response?.ErrorCode !== NOT_CONFIRMED_ERROR_CODE) break;
            this.logger.warn(`RControl did not confirm the arming state change (attempt ${attempt}/${MAX_ATTEMPTS}).` + (attempt < MAX_ATTEMPTS ? ' Retrying...' : ''));
        }
        return response;
    }

    deviceStateToHapState(deviceState: DeviceState): CharacteristicValue {
        // HAP's Stay and Night are both reported back as Stay since the panel only reports one
        // "stay" status.
        switch (deviceState) {
            case DeviceState.AWAY_ARMED:
                return this.hap.Characteristic.SecuritySystemTargetState.AWAY_ARM;
            case DeviceState.STAY_ARMED:
                return this.hap.Characteristic.SecuritySystemTargetState.STAY_ARM;
            default:
                return this.hap.Characteristic.SecuritySystemTargetState.DISARM;
        }
    }

    hapStateToServerState(hapState: CharacteristicValue): ServerAlarmState {
        // HAP's Home and Night both arm the panel in "stay" mode; Away arms it in "away" mode.
        switch (hapState) {
            case this.hap.Characteristic.SecuritySystemTargetState.DISARM:
                return ServerAlarmState.DISARMED;
            case this.hap.Characteristic.SecuritySystemTargetState.STAY_ARM:
            case this.hap.Characteristic.SecuritySystemTargetState.NIGHT_ARM:
                return ServerAlarmState.STAY;
            default:
                return ServerAlarmState.ARMED;
        }
    }

    getServices(): Service[] {
        return [
            this.informationService,
            this.service
        ];
    }

}
