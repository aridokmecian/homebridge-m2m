const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const { M2MAPI } = require('../dist/api');

// Logs from a login attempted purely to list panels for the config UI aren't useful in the main
// Homebridge log, so this satisfies M2MAPI's Logging interface with no-ops.
const silentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    log: () => {},
};

class PluginUiServer extends HomebridgePluginUiServer {
    constructor() {
        super();
        this.onRequest('/fetchPanels', this.fetchPanels.bind(this));
        this.ready();
    }

    async fetchPanels({ username, password }) {
        if (!username || !password) {
            throw new Error('Enter a username and password first.');
        }

        const api = new M2MAPI(silentLogger);
        await api.login(username, password);
        if (!api.isLoggedIn()) {
            throw new Error('Login failed - check your username and password.');
        }

        const userSettings = await api.getUserSettings();
        const panels = userSettings?.HAUserSettings?.AlarmIMEIUserNumbers ?? [];
        if (panels.length === 0) {
            throw new Error('No panels were found on this account.');
        }

        // Labels are best-effort: if this call fails, panels are still returned with just IMEIs.
        const mobileDevicesInfo = await api.getMobileDevicesInfo();
        const labelsByImei = new Map(
            (mobileDevicesInfo?.MobileDevicesInfo ?? []).map((device) => [device.IMEI, device.Label])
        );

        return panels.map((panel) => ({ ...panel, Label: labelsByImei.get(panel.IMEI) || null }));
    }
}

(() => new PluginUiServer())();
