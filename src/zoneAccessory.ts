import { HAP, Logging, PlatformAccessory, Service } from "homebridge";
import { ZoneServiceType } from "./types";

// Wraps a single zone's PlatformAccessory: attaches the right HAP service for its type and
// pushes state updates from the poll loop, skipping redundant writes when nothing changed.
export class ZoneAccessory {

    private readonly logger: Logging;
    private readonly hap: HAP;
    private readonly service: Service;
    private readonly serviceType: ZoneServiceType;
    private readonly displayName: string;
    private lastZoneState: number | undefined = undefined;

    constructor(accessory: PlatformAccessory, hap: HAP, logger: Logging, serviceType: ZoneServiceType, displayName: string, initialZoneState: number) {
        this.logger = logger;
        this.hap = hap;
        this.serviceType = serviceType;
        this.displayName = displayName;

        const serviceClass = serviceType === ZoneServiceType.MOTION ? hap.Service.MotionSensor : hap.Service.ContactSensor;
        this.service = accessory.getService(serviceClass) || accessory.addService(serviceClass, displayName);
        this.service.setCharacteristic(hap.Characteristic.Name, displayName);

        this.updateState(initialZoneState);
    }

    // ZoneState 1 means secure/closed; anything else means open/triggered.
    updateState(zoneState: number) {
        if (zoneState === this.lastZoneState) return;

        const isOpen = zoneState !== 1;
        if (this.lastZoneState !== undefined) {
            this.logger.info(`[M2M] Zone "${this.displayName}" changed: ${isOpen ? 'open/triggered' : 'secure'}`);
        }
        this.lastZoneState = zoneState;

        if (this.serviceType === ZoneServiceType.MOTION) {
            this.service.updateCharacteristic(this.hap.Characteristic.MotionDetected, isOpen);
        } else {
            this.service.updateCharacteristic(
                this.hap.Characteristic.ContactSensorState,
                isOpen ? this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED
            );
        }
    }

}
