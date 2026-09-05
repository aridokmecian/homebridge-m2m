export interface Options {
    name: string,
    username: string,
    password: string,
    imei?: string,
    partitionNumber?: string,
    enableZoneSensors?: boolean,
    pollingIntervalSeconds?: number
}

export interface CreateAuthCodePostResponse {
    AdminLogin: string,
    AuthCode: string,
    ErrorCode: number,
    ErrorMsg: string,
    Success: boolean
}

export interface CreateAccessTokenPostResponse {
    AccessToken: string,
    AdminLogin: boolean,
    ErrorCode: number,
    ErrorMsg: string,
    ExpirationDate: number,
    RefreshToken: string,
    Success: boolean
}

export interface AlarmIMEIUserNumber {
    IMEI: string,
    Number: string
}

export interface MobileDeviceInfo {
    IMEI: string,
    SN: string,
    Connected: boolean,
    Label: string | null
}

// Response shape of POST /api/v3/getmobiledevicesinfo, confirmed via a live capture of the iOS
// app's traffic. Label is the account's own human-readable name for the panel (e.g. an address) -
// only used by the config UI's panel picker to show something more useful than a bare IMEI.
export interface GetMobileDevicesInfoPostResponse {
    MobileDevicesInfo: MobileDeviceInfo[]
}

export interface GetUserSettingsPostResponse {
    ErrorCode: number,
    ErrorString: string,
    HAUserSettings: {
        Administrator: boolean,
        AlarmIMEIUserNumbers: AlarmIMEIUserNumber[],
        AvailableCultures: any,
        ClientID: number,
        ControllerPermitions: any,
        Culture: string,
        DiagnosticEnable: boolean,
        Email: string,
        GDPRAgreements: boolean,
        HasCreditAcount: boolean,
        ID: string,
        IsApproved: boolean,
        IsLockedOut: boolean,
        Name: string,
        OwnerUserID: string,
        PasswordNew: string,
        PasswordOld: string,
        PhoneCulture: string,
        ReadOnly: boolean,
        UserName: string,
        UserNameNew: string
    },
    Success: boolean,
    SystemSettingsVersion: string
}

export interface UpdateArmStatusPostResponse {
    ErrorCode: number,
    ErrorString: string,
    Success: boolean
}

// ArmingState codes expected by POST /api/v3/remotearm (the command we send), confirmed via a
// live capture of the iOS app's traffic.
export enum ServerAlarmState {
    DISARMED = 0,
    ARMED = 1,
    STAY = 2
}

// DeviceState codes returned by getalldevicedata (the panel's reported status), confirmed via a
// live capture. This is a different numbering than ServerAlarmState above.
export enum DeviceState {
    AWAY_ARMED = 1,
    DISARMED = 2,
    STAY_ARMED = 3
}

// A single zone (door/window/motion contact) as reported by the panel. ZoneName is only present
// on the v3 getalldevicedata response (used for one-time discovery); the getdevicestatusdata
// polling response omits it, since callers are expected to already know each zone's name.
export interface Zone {
    ZoneName: string | null,
    ZoneID: string,
    ZoneState: number,
    ZoneRSSI: number,
    ZoneIcon: string | null,
    PartitionNumber: string
}

// Confirmed via a live capture: ExternalDevices can include non-partition pseudo-entries (e.g. an
// "EmergencyKeys" entry with PartitionNumber: null and ZonesInfo: null) alongside the real
// partition device, whose Name is account-specific (the panel's own serial-like name, not a
// generic "Partition N" string) - so partitions must be matched by PartitionNumber, not Name.
export interface ZonePartition {
    Name: string,
    PartitionNumber: string | null,
    DeviceState: DeviceState,
    ZonesInfo: Zone[] | null
}

// Response shape of POST /api/v3/getalldevicedata, confirmed via a live capture of the iOS app's
// traffic. Used both to discover the zones on the account's first (or configured) partition
// alongside their names, and to read the partition's current DeviceState.
export interface GetAllDeviceDataPostResponse {
    AlarmControlSettingsV2Response: {
        SerialNumber: string,
        ExternalDevices: ZonePartition[]
    }
}

// Response shape of POST /api/v3/getdevicestatusdata, confirmed via a live capture of the iOS
// app's traffic. Polled periodically for zone state changes; ZonesInfo is null when the panel is
// unreachable. Unlike getalldevicedata (above), ExternalDevices is NOT nested under an
// AlarmControlSettingsV2Response envelope here - it's top-level on the response itself.
export interface GetDeviceStatusDataPostResponse {
    ExternalDevices: ZonePartition[]
}

// Which HAP service a zone is exposed as, derived from keywords in its raw name.
export enum ZoneServiceType {
    CONTACT = 'contact',
    MOTION = 'motion'
}