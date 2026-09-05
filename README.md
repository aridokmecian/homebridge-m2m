<p align="center"><img src="branding/icon.svg" width="150" alt="homebridge-m2m icon"></p>

# homebridge-m2m
### 🚨 M2M Services Alarm System Plugin for Homebridge

`homebridge-m2m` is a plugin for [Homebridge](https://homebridge.io/) that enables security systems accessible from RControl or DSC Connect (iOS/Android apps built on the same M2M Services backend) to be used through HomeKit.

This is a fork of [homebridge-rcontrol](https://github.com/aabosh/homebridge-rcontrol) by Andrew Abosh, renamed after the M2M Services API that RControl runs on.

## Features
- Arm and disarm your security system from the Home app or Siri
- Log in with either your RControl or DSC Connect account credentials
- Pick which panel to control from a live dropdown in the plugin's Settings UI, populated from your actual account — no need to look up an IMEI by hand
- Optionally expose each alarm zone (doors, windows, motion) as its own HomeKit contact/motion sensor
- Support for accounts with multiple panels or partitions: add multiple platform entries and point each one at a specific panel/partition (see Notes)
- Fast, responsive status updates in the Home app
- Debug logging for troubleshooting
- Built for Homebridge v2 and modern Node.js

## Requirements
- Node.js 22, 24, or 26
- Homebridge 2.0.0 or later

## Configuration
homebridge-m2m is a Homebridge **platform**, configured under `platforms` in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "M2M",
      "name": "Alarm",
      "username": "...",
      "password": "...",
      "enableZoneSensors": false
    }
  ]
}
```

> **Upgrading from an earlier version?** homebridge-m2m used to be a Homebridge **accessory**, configured under `accessories`. Move your existing block from `accessories` to `platforms` and rename its `accessory` field to `platform` (same field values otherwise). This is a one-time breaking change — see Notes for what else it affects.

Set `enableZoneSensors: true` to also register a contact or motion sensor for each zone on the panel, polled for state changes every 10 seconds by default (configurable under Advanced Settings). Zone names and sensor types (contact vs. motion) are auto-discovered from the panel; no per-zone configuration is needed.

The Config UI's settings form for this plugin includes a **Panel** dropdown: with a username and password entered, click **Fetch Panels** to log in and list the actual panels on your account (labeled with whatever name your account has for them, e.g. an address) instead of typing in an IMEI. Partition number and the zone polling interval live under an **Advanced Settings** section, collapsed by default — most users won't need to touch them.

## Notes
- Migrating from the old accessory-based config gives your panel a new HomeKit accessory identity (Homebridge platforms manage their own accessory IDs, separate from the old accessory-plugin ones) — you'll need to re-add it to any HomeKit rooms, scenes, or automations that referenced the old one.
- By default, homebridge-m2m controls the first panel and partition on your account. If you have more than one, use the Settings UI's Panel dropdown (or the optional `imei`/`partitionNumber` config fields) to pick which one a given platform entry controls. This is untested against a real multi-panel/multi-partition account — please open an issue if it doesn't work as expected.
- If you configure more than one platform entry (for a multi-panel/multi-partition account), only the first one is editable through the Settings UI described above — add or edit additional entries via the raw JSON config editor instead.
- Home and Night both arm the panel in the same "stay" mode, since the panel itself doesn't distinguish between them; Away arms separately. The plugin remembers which of the two you last set so it's reported back correctly (to the Home app and any automations) instead of always showing as Home.
- Switching directly between Away and Home/Night from the Home app briefly disarms the panel before re-arming into the requested mode, since M2M's API doesn't support switching between armed modes directly.
- Due to limited testing and the usage of M2M's undocumented and private API, this is unstable and may cease to work in the future. 

## Releasing
Releases publish to npm via a GitHub Actions workflow (`.github/workflows/publish.yml`) using npm's trusted publishing (OIDC) — no stored npm token. To cut a release:

1. `npm version <major|minor|patch>` — bumps `package.json`, commits, and tags locally
2. `git push && git push --tags`
3. Create a GitHub Release from that tag (via the GitHub UI, or `gh release create v<version>`)
4. The workflow runs and stages the version on npm (`npm stage publish`) — this does **not** make it live
5. Approve it to actually publish: `npm stage approve homebridge-m2m@<version>` (requires 2FA; can't be automated by design)

## License
`homebridge-m2m` is licensed under the MIT license.
