export interface Options {
    name: string,
    username: string,
    password: string,
    pin: string
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
    RefreshToken: string, 
    Success: boolean
}

interface AlarmIMEIUserNumber {
    IMEI: string,
    Number: string
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

interface ExternalDevice {
    DeviceState: DeviceState,
    DevicePIN: number,
    PartitionNumber: string
}

export interface GetAllDeviceDataPostResponse {
    AlarmControlSettingsV2Response: {
        SerialNumber: string,
        ExternalDevices: ExternalDevice[]
    },
    ClientDeviceDataV2Response: {
        SerialNumber: string,
        SiteNo: string
    }
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