import { API, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { Options } from "./types";
import { M2MAPI } from "./api";
import { SecuritySystemAccessory } from "./securitySystemAccessory";
import { ZoneAccessory } from "./zoneAccessory";
import { normalizeZoneName, zoneServiceTypeForName } from "./zoneNaming";

// The native app polls zone status roughly every 7s; 10s is safe and polite, and is the default
// exposed via the pollingIntervalSeconds config option.
const DEFAULT_ZONE_POLL_INTERVAL_SECONDS = 10;
// Matches the schema's minimum, enforced again here in case config.json was hand-edited past it.
const MIN_ZONE_POLL_INTERVAL_SECONDS = 5;

export class M2MPlatform implements DynamicPlatformPlugin {

    private readonly logger: Logging;
    private readonly config: Options;
    private readonly api: API;
    private readonly hap: HAP;
    private readonly m2mApi: M2MAPI;

    // Accessories Homebridge restored from its cache on startup. Claimed (removed from this map)
    // as we match them to a discovered panel/zone during didFinishLaunching; whatever's left
    // afterward is stale and gets unregistered.
    private readonly cachedAccessories = new Map<string, PlatformAccessory>();
    private readonly zoneAccessories = new Map<string, ZoneAccessory>();

    private zoneImei: string | undefined = undefined;
    private zoneUserId: string | undefined = undefined;
    private zoneSerialNumber: string | undefined = undefined;
    private zonePollInterval: ReturnType<typeof setInterval> | undefined = undefined;

    constructor(logger: Logging, config: PlatformConfig, api: API) {
        this.logger = logger;
        this.api = api;
        this.hap = api.hap;
        this.m2mApi = new M2MAPI(logger);

        this.config = {
            name: (config.name as string) || 'Alarm',
            username: config.username as string,
            password: config.password as string,
            imei: config.imei as string | undefined,
            partitionNumber: config.partitionNumber as string | undefined,
            enableZoneSensors: config.enableZoneSensors as boolean | undefined,
            pollingIntervalSeconds: config.pollingIntervalSeconds as number | undefined
        };

        this.api.on('didFinishLaunching', () => this.didFinishLaunching());
        this.api.on('shutdown', () => this.shutdown());
    }

    // Called by Homebridge once per accessory it restored from its on-disk cache, before
    // didFinishLaunching. We just hold onto them until we know what we're actually discovering.
    configureAccessory(accessory: PlatformAccessory) {
        this.cachedAccessories.set(accessory.UUID, accessory);
    }

    // Thin wrapper around the real startup logic: this runs off a Homebridge event with nothing
    // above it to catch a rejection, so an unexpected error here (e.g. an API response shaped
    // differently than expected) must not crash the whole process.
    private async didFinishLaunching() {
        try {
            await this.didFinishLaunchingUnsafe();
        } catch (error) {
            this.logger.error(`[M2M] Unexpected error during startup: ${error}`);
        }
    }

    private async didFinishLaunchingUnsafe() {
        if (!this.config.username || !this.config.password) {
            this.logger.error('[M2M] No M2M credentials provided.');
            return;
        }

        await this.m2mApi.login(this.config.username, this.config.password);
        this.registerSecuritySystemAccessory();

        if (this.config.enableZoneSensors) {
            await this.setUpZoneSensors();
        }

        // Anything left in the cache wasn't claimed above (e.g. a zone that's gone, or zone
        // sensors got turned off) - remove it so it doesn't linger as a ghost accessory.
        for (const stale of this.cachedAccessories.values()) {
            this.logger.info(`[M2M] Removing stale accessory: ${stale.displayName}`);
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [stale]);
        }
        this.cachedAccessories.clear();
    }

    private async setUpZoneSensors() {
        const userSettings = await this.m2mApi.getUserSettings();
        if (userSettings === undefined || userSettings.HAUserSettings.AlarmIMEIUserNumbers.length === 0) {
            this.logger.error('[M2M] Failed to enable zone sensors: the provided credentials have no alarms in the account.');
            return;
        }

        const imeiNumbers = userSettings.HAUserSettings.AlarmIMEIUserNumbers;
        const imeiUserNumber = this.config.imei
            ? imeiNumbers.find(number => number.IMEI === this.config.imei)
            : imeiNumbers[0];
        if (imeiUserNumber === undefined) {
            this.logger.error(`[M2M] Configured IMEI "${this.config.imei}" was not found on this account.`);
            return;
        }

        await this.discoverAndRegisterZones(imeiUserNumber.IMEI, userSettings.HAUserSettings.ID);

        const intervalSeconds = Math.max(MIN_ZONE_POLL_INTERVAL_SECONDS, this.config.pollingIntervalSeconds || DEFAULT_ZONE_POLL_INTERVAL_SECONDS);
        this.zonePollInterval = setInterval(() => this.pollZoneStates(), intervalSeconds * 1000);
    }

    private registerSecuritySystemAccessory() {
        const uuid = this.hap.uuid.generate(`${PLUGIN_NAME}:panel:${this.config.name}`);
        const existing = this.cachedAccessories.get(uuid);
        const accessory = existing ?? new this.api.platformAccessory(this.config.name, uuid);

        if (existing) {
            this.cachedAccessories.delete(uuid);
            accessory.displayName = this.config.name;
            this.api.updatePlatformAccessories([accessory]);
        } else {
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }

        new SecuritySystemAccessory(accessory, this.logger, this.config, this.hap, this.m2mApi);
    }

    // Matches the same partitionNumber config field the panel accessory uses. Partitions must be
    // matched by PartitionNumber, not Name: ExternalDevices can include non-partition entries
    // (e.g. "EmergencyKeys", with PartitionNumber: null), and the real partition's Name is an
    // account-specific panel name, not a generic "Partition N" string.
    private zonePartitionNumber(): string {
        return this.config.partitionNumber || '1';
    }

    private async discoverAndRegisterZones(imei: string, userId: string) {
        const response = await this.m2mApi.getAllDeviceData({
            'IMEI': imei,
            'ProtocolNumber': 5,
            'ReturnCamerasData': false,
            'UserID': userId
        });
        if (response === undefined) {
            this.logger.error('[M2M] Failed to discover zones: no response from the panel.');
            return;
        }

        const partitionNumber = this.zonePartitionNumber();
        const partition = response.AlarmControlSettingsV2Response.ExternalDevices.find(device => device.PartitionNumber === partitionNumber);
        if (partition === undefined) {
            this.logger.error(`[M2M] Failed to discover zones: no partition numbered "${partitionNumber}" found.`);
            return;
        }

        this.zoneImei = imei;
        this.zoneUserId = userId;
        this.zoneSerialNumber = response.AlarmControlSettingsV2Response.SerialNumber;

        for (const zone of partition.ZonesInfo ?? []) {
            const rawName = zone.ZoneName ?? `Zone ${zone.ZoneID}`;
            const displayName = normalizeZoneName(rawName);
            const serviceType = zoneServiceTypeForName(rawName);

            const uuid = this.hap.uuid.generate(`${PLUGIN_NAME}:zone:${imei}:${zone.ZoneID}`);
            const existing = this.cachedAccessories.get(uuid);
            const accessory = existing ?? new this.api.platformAccessory(displayName, uuid);

            if (existing) {
                this.cachedAccessories.delete(uuid);
                accessory.displayName = displayName;
                this.api.updatePlatformAccessories([accessory]);
            } else {
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }

            this.zoneAccessories.set(zone.ZoneID, new ZoneAccessory(accessory, this.hap, this.logger, serviceType, displayName, zone.ZoneState));
        }

        this.logger.info(`[M2M] Discovered ${this.zoneAccessories.size} zone(s) on partition ${partitionNumber}.`);
    }

    // Same reasoning as didFinishLaunching: this runs off a setInterval timer, so a thrown/rejected
    // error here has no caller to catch it and would otherwise crash the process.
    private pollZoneStates = async () => {
        try {
            await this.pollZoneStatesUnsafe();
        } catch (error) {
            this.logger.error(`[M2M] Unexpected error while polling zone states: ${error}`);
        }
    }

    private pollZoneStatesUnsafe = async () => {
        if (this.zoneImei === undefined || this.zoneUserId === undefined || this.zoneSerialNumber === undefined) return;

        const response = await this.m2mApi.getDeviceStatusData({
            'BypassingZones': true,
            'IMEI': this.zoneImei,
            'LoadLastSnapshots': false,
            'ProtocolNumber': 5,
            'SerialNumber': this.zoneSerialNumber,
            'UserID': this.zoneUserId
        });
        if (response === undefined) return;

        const partition = response.ExternalDevices.find(device => device.PartitionNumber === this.zonePartitionNumber());
        if (partition === undefined || !partition.ZonesInfo) {
            // Panel unreachable this tick (or the partition wasn't returned) - skip rather than
            // mark zones open on missing data.
            return;
        }

        for (const zone of partition.ZonesInfo) {
            this.zoneAccessories.get(zone.ZoneID)?.updateState(zone.ZoneState);
        }
    }

    private shutdown() {
        if (this.zonePollInterval !== undefined) {
            clearInterval(this.zonePollInterval);
        }
    }

}
