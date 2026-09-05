import { CharacteristicEventTypes, CharacteristicGetCallback, CharacteristicSetCallback, CharacteristicValue, HAP, Logging, PlatformAccessory } from "homebridge";
import { ServerAlarmState, DeviceState, Options, GetUserSettingsPostResponse, GetAllDeviceDataPostResponse, AlarmIMEIUserNumber, ZonePartition } from "./types";
import { M2MAPI } from "./api";

// The security panel accessory: arm/disarm state and HomeKit's SecuritySystem service. Wraps a
// PlatformAccessory managed by M2MPlatform, rather than being a standalone AccessoryPlugin.
export class SecuritySystemAccessory {

    private readonly logger: Logging;
    private readonly config: Options;
    private readonly hap: HAP;
    private readonly m2mApi: M2MAPI;
    private readonly service;

    private lastUserSettingsResponse: GetUserSettingsPostResponse | undefined = undefined;
    private lastDeviceDataResponse: GetAllDeviceDataPostResponse | undefined = undefined;
    private targetState: CharacteristicValue | undefined = undefined;
    private lastKnownState: CharacteristicValue | undefined = undefined;
    // M2M only has one "stay" mode - DeviceState.STAY_ARMED can't tell Home and Night apart
    // on its own, so deviceStateToHapState falls back to whichever of the two was last actually
    // requested, rather than always collapsing back to Home. Defaults to Home.
    private stayArmSubMode: CharacteristicValue;

    constructor(accessory: PlatformAccessory, logger: Logging, config: Options, hap: HAP, m2mApi: M2MAPI) {
        this.logger = logger;
        this.config = config;
        this.hap = hap;
        this.m2mApi = m2mApi;
        this.stayArmSubMode = hap.Characteristic.SecuritySystemTargetState.STAY_ARM;

        this.service = accessory.getService(hap.Service.SecuritySystem) || accessory.addService(hap.Service.SecuritySystem, config.name);
        accessory.getService(hap.Service.AccessoryInformation) || accessory.addService(hap.Service.AccessoryInformation);

        this.service.getCharacteristic(this.hap.Characteristic.SecuritySystemCurrentState)
            .on(CharacteristicEventTypes.GET, this.handleSecuritySystemCurrentStateGet.bind(this));

        this.service.getCharacteristic(this.hap.Characteristic.SecuritySystemTargetState)
            .on(CharacteristicEventTypes.GET, this.handleSecuritySystemTargetStateGet.bind(this))
            .on(CharacteristicEventTypes.SET, this.handleSecuritySystemTargetStateSet.bind(this));
    }

    handleSecuritySystemCurrentStateGet(callback: CharacteristicGetCallback) {
        // Fetching state from M2M's cloud can take several seconds, which is enough to trip
        // Homebridge's "slow to respond" warning if we make HomeKit wait on it. Answer from the
        // last known state when we have one, and refresh it in the background instead.
        if (this.lastKnownState !== undefined) {
            callback(null, this.lastKnownState);
            this.refreshAlarmState();
            return;
        }
        this.refreshAlarmState()
            .then(state => {
                if (state === undefined) {
                    callback(new Error('Failed to fetch current alarm state from M2M.'));
                } else {
                    callback(null, state);
                }
            })
            .catch(error => {
                this.logger.error(`[M2M] Unexpected error while fetching current alarm state: ${error}`);
                callback(error instanceof Error ? error : new Error(String(error)));
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
        this.refreshAlarmState()
            .then(state => {
                if (state === undefined) {
                    callback(new Error('Failed to fetch current alarm state from M2M.'));
                } else {
                    callback(null, state);
                }
            })
            .catch(error => {
                this.logger.error(`[M2M] Unexpected error while fetching current alarm state: ${error}`);
                callback(error instanceof Error ? error : new Error(String(error)));
            });
    }

    handleSecuritySystemTargetStateSet(value: CharacteristicValue, callback: CharacteristicSetCallback) {
        const targetServerState = this.hapStateToServerState(value);
        this.logger.info(`[M2M] Target state change requested: ${this.hapStateLabel(this.targetState)} -> ${this.hapStateLabel(value)}`);

        if (value === this.hap.Characteristic.SecuritySystemTargetState.STAY_ARM || value === this.hap.Characteristic.SecuritySystemTargetState.NIGHT_ARM) {
            this.stayArmSubMode = value;
        }

        // Home and Night both arm M2M in the same "stay" mode, which the panel doesn't
        // distinguish. If we're already stay-armed, switching between Home and Night is a
        // local-only change; skip hitting M2M and just reflect the new HAP state.
        const previousServerState = this.targetState !== undefined ? this.hapStateToServerState(this.targetState) : undefined;
        if (targetServerState === ServerAlarmState.STAY && previousServerState === ServerAlarmState.STAY) {
            this.logger.info(`[M2M] ${this.hapStateLabel(this.targetState)} -> ${this.hapStateLabel(value)} is a Home/Night-only change; not contacting M2M.`);
            this.targetState = value;
            this.lastKnownState = value;
            this.service.getCharacteristic(this.hap.Characteristic.SecuritySystemCurrentState).updateValue(value);
            callback();
            return;
        }

        // M2M's API only supports arming from a disarmed state; it rejects a direct switch
        // between away-armed and stay-armed. The Home app lets the user do that switch directly
        // from its buttons, so when it happens we disarm first and then arm into the requested
        // state on M2M's behalf.
        const needsDisarmFirst = previousServerState !== undefined
            && previousServerState !== ServerAlarmState.DISARMED
            && targetServerState !== ServerAlarmState.DISARMED
            && previousServerState !== targetServerState;

        let armSequence;
        if (needsDisarmFirst) {
            this.logger.info(`[M2M] Disarming before switching from ${this.hapStateLabel(this.targetState)} to ${this.hapStateLabel(value)}...`);
            armSequence = this.updateAlarmState(ServerAlarmState.DISARMED).then(disarmResponse => {
                if (disarmResponse?.ErrorCode !== 0) {
                    this.logger.error('[M2M] Failed to disarm before switching arming mode; skipping re-arm.');
                    return disarmResponse;
                }
                this.logger.info(`[M2M] Disarmed; now arming to ${this.hapStateLabel(value)}...`);
                return this.updateAlarmState(targetServerState);
            });
        } else {
            armSequence = this.updateAlarmState(targetServerState);
        }

        armSequence
            .then(() => this.refreshAlarmState())
            .then(() => callback())
            .catch(error => {
                this.logger.error(`[M2M] Unexpected error while changing the arming state: ${error}`);
                callback(error instanceof Error ? error : new Error(String(error)));
            });
    }

    // Fetches the current alarm state, caches it, and pushes it to the CurrentState/TargetState
    // characteristics so HomeKit picks it up even when nothing was actively waiting on this call.
    refreshAlarmState = (): Promise<CharacteristicValue | undefined> => {
        return this.getCurrentAlarmState().then(state => {
            if (state !== undefined) {
                if (state !== this.lastKnownState) {
                    this.logger.info(`[M2M] Current state changed: ${this.hapStateLabel(this.lastKnownState)} -> ${this.hapStateLabel(state)}`);
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

    // Picks which panel on the account this accessory controls: the one matching the configured
    // IMEI, or the first on the account when none is configured.
    selectImeiUserNumber = (userSettings: GetUserSettingsPostResponse): AlarmIMEIUserNumber | undefined => {
        const numbers = userSettings.HAUserSettings.AlarmIMEIUserNumbers;
        if (!this.config.imei) return numbers[0];
        const match = numbers.find(number => number.IMEI === this.config.imei);
        if (match === undefined) {
            this.logger.error(`[M2M] Configured IMEI "${this.config.imei}" was not found on this account.`);
        }
        return match;
    }

    // Picks which partition on the selected panel this accessory controls: the one matching the
    // configured partition number, or partition "1" when none is configured. ExternalDevices can
    // include non-partition pseudo-entries (e.g. "EmergencyKeys", with PartitionNumber: null), so
    // this must match by PartitionNumber rather than taking the first entry in the array.
    selectExternalDevice = (deviceData: GetAllDeviceDataPostResponse): ZonePartition | undefined => {
        const devices = deviceData.AlarmControlSettingsV2Response.ExternalDevices;
        const partitionNumber = this.config.partitionNumber || '1';
        const match = devices.find(device => device.PartitionNumber === partitionNumber);
        if (match === undefined) {
            this.logger.error(`[M2M] Configured partition "${partitionNumber}" was not found on this panel.`);
        }
        return match;
    }

    getCurrentAlarmState = async (): Promise<CharacteristicValue | undefined> => {
        if (this.lastUserSettingsResponse === undefined) { // We haven't fetched user settings yet
            const userSettingsResponse = await this.m2mApi.getUserSettings();
            if (userSettingsResponse === undefined) return;

            if (userSettingsResponse.HAUserSettings.AlarmIMEIUserNumbers.length === 0) {
                this.logger.error('Failed to fetch alarm state: the provided credentials have no alarms in the account.');
            } else {
                this.lastUserSettingsResponse = userSettingsResponse;
            }
        }

        if (this.lastUserSettingsResponse === undefined) return;
        const imeiUserNumber = this.selectImeiUserNumber(this.lastUserSettingsResponse);
        if (imeiUserNumber === undefined) return;

        const body = {
            // The following is what the v3 API expects, confirmed via a live capture of the iOS
            // app's traffic.
            'IMEI': imeiUserNumber.IMEI,
            'ProtocolNumber': 5,
            'ReturnCamerasData': false,
            'UserID': this.lastUserSettingsResponse.HAUserSettings.ID
        }
        const deviceDataResponse = await this.m2mApi.getAllDeviceData(body);
        if (deviceDataResponse?.AlarmControlSettingsV2Response.ExternalDevices.length === 0) {
            this.logger.error('Failed to fetch alarm state: the provided credentials have no external devices in the account.');
        } else {
            this.lastDeviceDataResponse = deviceDataResponse;
        }
        const externalDevice = deviceDataResponse !== undefined ? this.selectExternalDevice(deviceDataResponse) : undefined;
        return externalDevice !== undefined ? this.deviceStateToHapState(externalDevice.DeviceState) : undefined;
    }

    updateAlarmState = async (newState: ServerAlarmState) => {
        if (this.lastUserSettingsResponse === undefined || this.lastDeviceDataResponse === undefined) return;
        const imeiUserNumber = this.selectImeiUserNumber(this.lastUserSettingsResponse);
        const externalDevice = this.selectExternalDevice(this.lastDeviceDataResponse);
        if (imeiUserNumber === undefined || externalDevice === undefined) return;

        // The following is what the v3 API expects, confirmed via a live capture of the iOS
        // app's traffic. UserPIN is the literal string "EMPTY" when arming and is omitted
        // entirely when disarming; UserNumber is always sent empty.
        const body: { [key: string]: unknown } = {
            'IMEI': imeiUserNumber.IMEI,
            'UserNumber': '',
            'ArmingState': newState,
            'SerialNumber': this.lastDeviceDataResponse.AlarmControlSettingsV2Response.SerialNumber,
            'ProtocolNumber': 5,
            'OutPIN': '',
            'PartitionNumber': externalDevice.PartitionNumber
        }
        if (newState !== ServerAlarmState.DISARMED) {
            body['UserPIN'] = 'EMPTY';
        }

        // The panel occasionally fails to confirm the state change back to M2M's server on
        // the first try (ErrorCode -2038, "NOT CONFIRMED") even though the command went through;
        // retrying once has been reliable.
        const NOT_CONFIRMED_ERROR_CODE = -2038;
        const MAX_ATTEMPTS = 5;
        let response;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            response = await this.m2mApi.updateArmStatus(body);
            if (response?.ErrorCode !== NOT_CONFIRMED_ERROR_CODE) break;
            this.logger.warn(`M2M did not confirm the arming state change (attempt ${attempt}/${MAX_ATTEMPTS}).` + (attempt < MAX_ATTEMPTS ? ' Retrying...' : ''));
        }
        return response;
    }

    deviceStateToHapState(deviceState: DeviceState): CharacteristicValue {
        // The panel only reports one "stay" status, so a stay-armed DeviceState is reported back
        // as whichever of Home/Night was last actually requested (stayArmSubMode), rather than
        // always collapsing to Home - otherwise setting Night would immediately read back as Home.
        switch (deviceState) {
            case DeviceState.AWAY_ARMED:
                return this.hap.Characteristic.SecuritySystemTargetState.AWAY_ARM;
            case DeviceState.STAY_ARMED:
                return this.stayArmSubMode;
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

}
