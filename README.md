# homebridge-homematic-ccu

[**English**](README.md) | [Deutsch](README.de.md)

Homebridge plugin for the **Homematic CCU3 and OpenCCU** (also RaspberryMatic and CCU2), written for **Homebridge v2**.
It talks to the CCU via XML-RPC and receives state changes through an event callback, so there is no polling (exceptions: system variables and CUxD, see below).

> **Note on how this project came about:** The code of this plugin was written and tested entirely by **Claude** (an AI assistant by [Anthropic](https://www.anthropic.com)), commissioned and guided by the repository owner.
> The **original idea** comes from [thkl/homebridge-homematic](https://github.com/thkl/homebridge-homematic), the long-standing Homematic plugin for Homebridge. This project is a rewrite for Homebridge v2 and **not a fork**; no code from the original project was used. See [Credits](#credits).

**Status:** early version (0.1.0). The end-to-end test runs against a real Homebridge 2.x and a *simulated* CCU. The plugin has not yet been tested broadly against real hardware. Bug reports with logs are welcome.

## Contents

- [Features](#features)
- [Supported devices](#supported-devices)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Migrating from homebridge-homematic](#migrating-from-homebridge-homematic)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Development and tests](#development-and-tests)
- [Credits](#credits)
- [License](#license)

## Features

- Automatic device discovery through the CCU (BidCos-RF, HmIP-RF, optionally BidCos-Wired)
- Channel names from the CCU (ReGa) are used as HomeKit names
- Events via XML-RPC callback, with a watchdog that re-registers after a CCU restart or a lost connection
- Correctly typed writes (`FLOAT` as `double`, `ENUM`/`INTEGER` as `int`, `BOOL` as `bool`), as the CCU requires
- System variables (boolean) and CUxD channels as switches
- `include`/`exclude` filters and mapping as outlet, light or window in Config UI X

## Supported devices

| HomeKit | Homematic channel types | Example devices |
|---|---|---|
| Switch / outlet / light | `SWITCH`, `SWITCH_VIRTUAL_RECEIVER` | HM-LC-Sw1-FM, HmIP-PS, HmIP-PSM, HmIP-BSM, HmIP-FSM |
| Dimmer (light) | `DIMMER`, `DIMMER_VIRTUAL_RECEIVER` | HM-LC-Dim1T-FM, HmIP-BDT, HmIP-FDT |
| Blind / shutter (optionally as window) | `BLIND`, `BLIND_VIRTUAL_RECEIVER`, `SHUTTER_VIRTUAL_RECEIVER` | HM-LC-Bl1-FM, HmIP-BROLL, HmIP-FROLL, HmIP-BBL |
| Contact sensor | `SHUTTER_CONTACT`, `ROTARY_HANDLE_SENSOR`, `ROTARY_HANDLE_TRANSCEIVER` | HM-Sec-SC, HM-Sec-RHS, HmIP-SWDO, HmIP-SRH |
| Thermostat | `CLIMATECONTROL_RT_TRANSCEIVER`, `HEATING_CLIMATECONTROL_TRANSCEIVER`, `THERMALCONTROL_TRANSMIT` | HM-CC-RT-DN, HmIP-eTRV, HmIP-WTH, HmIP-STH |
| Switch (via ReGa) | System variables (boolean), CUxD channels | `Presence`, `CUxD.CUX0200001:1` |

The plugin decides which channels to expose based on the parameter description reported by the CCU (for example, only channels with a writable `STATE` or `LEVEL`). The device names in the table are examples of devices that use these channel types, not a verified compatibility list.

**Thermostats:** *Off* corresponds to the minimum temperature, *Heat* is manual mode, *Auto* switches to the automatic schedule. HmIP devices use `CONTROL_MODE`, the HM-CC-RT-DN uses `AUTO_MODE`/`MANU_MODE`. Changes to the target temperature are debounced so that dragging the HomeKit slider does not flood the CCU with commands.

**Blinds:** The position is passed through 1:1 (100 % = open). The movement direction comes from `ACTIVITY_STATE` (HmIP) or `WORKING`/`DIRECTION` (HM).

## Requirements

- Homebridge **1.9 or newer, including 2.x**, Node.js 20.18+, 22.10+ or 24
- A CCU3 or OpenCCU (RaspberryMatic/CCU2 should work the same way)
- CCU firewall (*Settings > Control panel > Security > Firewall*):
  - **Homematic XML-RPC API** set to *Full access* or *Restricted access*. With *Restricted access*, add the IP of your Homebridge host and open ports **2001** (RF) and **2010** (HmIP), plus **2000** for wired devices.
  - **Remote Homematic-Script API** for channel names, system variables and CUxD (port **8181**). Without it the plugin still works, but devices are named after type and address.
- The CCU connects back to Homebridge: TCP port `callbackPort` (default **9190**) must be reachable from the CCU. Keep this in mind with Docker or a firewall on the Homebridge host.
- Enabled authentication on the CCU (user name/password for XML-RPC and ReGa) is not supported yet.

## Installation

From a release package (`.tgz`):

```bash
# Homebridge image / hb-service
sudo hb-service add ./homebridge-homematic-ccu-0.1.0.tgz

# Homebridge installed globally via npm
sudo npm install -g ./homebridge-homematic-ccu-0.1.0.tgz
```

Directly from the repository:

```bash
sudo npm install -g github:<your-github-user>/homebridge-homematic-ccu
```

Docker (`homebridge/homebridge`): put the package into the `/homebridge` volume and run `cd /homebridge && npm install ./homebridge-homematic-ccu-0.1.0.tgz` inside the container.

Then restart Homebridge and configure the plugin in Config UI X under *Plugins*.

## Configuration

Minimal `config.json` example:

```json
{
  "platform": "HomematicCCU",
  "name": "Homematic CCU",
  "ccuHost": "192.168.0.100"
}
```

Extended example:

```json
{
  "platform": "HomematicCCU",
  "name": "Homematic CCU",
  "ccuHost": "192.168.0.100",
  "bidcosRf": true,
  "hmipRf": true,
  "outlets": ["BidCos-RF.NEQ0123456:1", "HmIP-RF.000213C99095C3:3"],
  "windows": ["BidCos-RF.NEQ0654321:1"],
  "exclude": ["NEQ0999999"],
  "variables": ["Presence_HomeKit"],
  "cuxdSwitches": ["CUxD.CUX0200001:1"],
  "serviceOverrides": [{ "type": "HM-LC-Sw4-SM:SWITCH", "kind": "blind" }]
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `ccuHost` | string | – | IP address or host name of the CCU (**required**) |
| `bidcosRf` | boolean | `true` | RF devices (port 2001) |
| `hmipRf` | boolean | `true` | HomeMatic IP (port 2010) |
| `bidcosWired` | boolean | `false` | Wired devices (port 2000) |
| `useReGaNames` | boolean | `true` | Use channel names from the CCU (port 8181) |
| `include` | list | empty | Only expose these devices/channels (empty = all supported) |
| `exclude` | list | empty | Exclude these devices/channels |
| `outlets` | list | empty | Switch channels to expose as outlet |
| `lights` | list | empty | Switch channels to expose as light |
| `windows` | list | empty | Blind channels to expose as HomeKit window |
| `variables` | list | empty | System variables (boolean) as switches |
| `cuxdSwitches` | list | empty | CUxD switch channels (accessed via ReGa) |
| `pollInterval` | number (s) | `10` | Polling interval for variables and CUxD (minimum 5) |
| `serviceOverrides` | list | empty | Override the mapping: `type` = `deviceType:channelType`, `kind` = `switch`, `dimmer`, `blind`, `contact` or `thermostat` |
| `localIp` | string | automatic | IP of the Homebridge host; only set if auto-detection picks the wrong one |
| `callbackPort` | number | `9190` | Port for events from the CCU |

Addresses in the lists refer to a device (`NEQ0123456`) or a channel (`NEQ0123456:1`). An interface prefix such as `BidCos-RF.`, `HmIP-RF.` or `CUxD.` may be written in front and is ignored.

If an HmIP device has several virtual receiver channels, only the first one is exposed automatically; add the others via `include`.

## Migrating from homebridge-homematic

The file `homematic_config.json` is not read; all settings live in the plugin config.

| old `homematic_config.json` | new |
|---|---|
| `filter_device`, `filter_channel` | `exclude` |
| `outlets` | `outlets` (optionally `lights`) |
| `windows` | `windows` |
| `variables` | `variables` (booleans only, via ReGa) |
| `services` (`"HM-LC-Sw4-SM:BLIND"` + service class) | `serviceOverrides` with `type` and `kind` |
| CUxD channels in `outlets` | `cuxdSwitches` (additionally in `outlets` to show them as outlet) |
| `programs` | not supported |

Also:

- Uninstall the old plugin and remove its cached accessories in Config UI X, otherwise devices appear twice.
- The accessories get new IDs. Rooms, scenes and automations in the Home app need to be reassigned.
- Not carried over: programs, garage door, Keymatic, smoke detectors, motion detectors, RGBW, battery status, variables other than booleans.

## How it works

1. On startup the plugin opens an XML-RPC server on `callbackPort` and registers it with the CCU's interfaces via `init`.
2. It reads the channels with `listDevices` and `getParamsetDescription` and maps them to a HomeKit service based on their type and writable data points. Each channel becomes one accessory.
3. The CCU sends changes to the plugin via `event`/`system.multicall`, and the plugin updates the HomeKit values. Writes go to the CCU as `setValue`.
4. A watchdog sends `ping` at regular intervals. If no events arrive for several minutes, the plugin registers again.
5. When devices change on the CCU (`newDevices`, `deleteDevices`, etc.), discovery is repeated after a short delay.
6. System variables and CUxD channels are read and written with ReGa scripts, because CUxD devices cannot be controlled via XML-RPC.

## Troubleshooting

| Symptom | Possible cause |
|---|---|
| Log shows `Anmeldung an der CCU fehlgeschlagen` (registration with the CCU failed) | CCU XML-RPC firewall, wrong IP, or port not opened |
| Devices show up, but state changes do not arrive | The CCU cannot reach `callbackPort` (firewall, Docker network, wrong `localIp`) |
| Log shows `seit … min keine Events` (no events for … min) | Callback blocked or CCU restarted; the plugin tries to re-register |
| Devices are named like `HmIP-… 00ABC:3` instead of their CCU name | *Remote Homematic-Script API* not enabled, or `useReGaNames` is off |
| A device is missing | Channel type not supported, filtered by `include`/`exclude`, or no writable data point; check with the debug log (`homebridge -D`) |
| An HmIP device shows up only once although it has several channels | Only the first virtual receiver channel is added automatically; add others via `include` |
| A variable or CUxD channel reacts with a delay | They are polled; reduce `pollInterval` |

Please attach a log created with `homebridge -D` (debug), from startup until the problem occurs, when reporting bugs. Device type and channel type are shown in the log lines for newly created accessories.

Note: log messages are currently in German.

## Limitations

- No support for enabled authentication on the CCU
- No programs, no system variables other than booleans, no Keymatic/garage door, no smoke or motion detectors, no RGBW, no battery status
- One accessory per channel; Homebridge limits a bridge to 150 accessories (use a child bridge or filter with `include` for large installations)
- Little experience yet with very large installations and with all device types on real hardware

## Development and tests

```bash
npm install
npm run build
npm test
```

`npm test` starts a real Homebridge 2.x together with a simulated CCU (XML-RPC on ports 2001 and 2010, ReGa on 8181) and pairs an HAP controller. Among other things it checks device selection, names, writes with correct data types, events (including via `system.multicall`), thermostat modes, `windows`, `serviceOverrides`, interface prefixes, and system variables and CUxD via ReGa. The ReGa scripts are only verified against the simulation, not against a real CCU.

The code is TypeScript and kept small: `src/rpc.ts` (XML-RPC and ReGa), `src/platform.ts` (discovery, mapping, polling) and one handler per device type in `src/handlers/`.

## Credits

- **Code:** written and tested by **Claude** (an AI assistant by [Anthropic](https://www.anthropic.com)), commissioned and guided by the repository owner, who reviews, publishes and is responsible for the result.
- **Original idea:** [thkl/homebridge-homematic](https://github.com/thkl/homebridge-homematic). The original project brought Homematic to HomeKit for many years and is now archived. This plugin picks up its idea (CCU devices appear in HomeKit automatically, configuration through lists such as `outlets` and `windows`) but is a complete rewrite and not a fork.
- The [`homematic-xmlrpc`](https://www.npmjs.com/package/homematic-xmlrpc) library is used for the XML-RPC transport. Homebridge and HAP-NodeJS belong to their respective projects.
- Homematic and Homematic IP are trademarks of eQ-3 AG. This project is not affiliated with eQ-3, ELV or Anthropic.

## License

[MIT](LICENSE)
