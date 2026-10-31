import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { HmDevice, HmEvent, HmParamsetDesc, HmRpc, INTERFACES, isWritable, firstKey } from './rpc';
import type { BaseHandler } from './handlers/base';
import { SwitchHandler } from './handlers/switch';
import { DimmerHandler } from './handlers/dimmer';
import { BlindHandler } from './handlers/blind';
import { ContactHandler } from './handlers/contact';
import { ThermostatHandler } from './handlers/thermostat';
import { RegaSwitchHandler } from './handlers/rega';

type Kind = 'switch' | 'dimmer' | 'blind' | 'contact' | 'thermostat';

const KIND_BY_TYPE: Record<string, Kind> = {
  SWITCH: 'switch',
  SWITCH_VIRTUAL_RECEIVER: 'switch',
  DIMMER: 'dimmer',
  DIMMER_VIRTUAL_RECEIVER: 'dimmer',
  BLIND: 'blind',
  BLIND_VIRTUAL_RECEIVER: 'blind',
  SHUTTER_VIRTUAL_RECEIVER: 'blind',
  SHUTTER_CONTACT: 'contact',
  ROTARY_HANDLE_SENSOR: 'contact',
  ROTARY_HANDLE_TRANSCEIVER: 'contact',
  CLIMATECONTROL_RT_TRANSCEIVER: 'thermostat',
  HEATING_CLIMATECONTROL_TRANSCEIVER: 'thermostat',
  THERMALCONTROL_TRANSMIT: 'thermostat',
};

interface HmConfig extends PlatformConfig {
  ccuHost?: string;
  bidcosRf?: boolean;
  hmipRf?: boolean;
  bidcosWired?: boolean;
  localIp?: string;
  callbackPort?: number;
  useReGaNames?: boolean;
  include?: string[];
  exclude?: string[];
  outlets?: string[];
  lights?: string[];
  windows?: string[];
  variables?: string[];
  cuxdSwitches?: string[];
  pollInterval?: number;
  serviceOverrides?: { type: string; kind: Kind }[];
}

const KINDS: Kind[] = ['switch', 'dimmer', 'blind', 'contact', 'thermostat'];
/** Entfernt das Interface-Präfix der alten Config ("BidCos-RF.NEQ123:1" -> "NEQ123:1"). */
const norm = (a: string): string => a.replace(/^(BidCos-RF|HmIP-RF|BidCos-Wired|CUxD)\./i, '');

function usable(kind: Kind, d: HmParamsetDesc): boolean {
  switch (kind) {
    case 'switch': return isWritable(d, 'STATE');
    case 'dimmer':
    case 'blind': return isWritable(d, 'LEVEL');
    case 'contact': return 'STATE' in d;
    case 'thermostat':
      return !!firstKey(d, ['ACTUAL_TEMPERATURE', 'TEMPERATURE']) &&
        (isWritable(d, 'SET_POINT_TEMPERATURE') || isWritable(d, 'SET_TEMPERATURE') || isWritable(d, 'MANU_MODE'));
  }
}

export class HomematicPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public rpc?: HmRpc;
  private readonly cfg: HmConfig;
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly handlers = new Map<string, BaseHandler>();
  private discoverTimer?: NodeJS.Timeout;
  private discovering = false;
  private pollTimer?: NodeJS.Timeout;
  private polling = false;

  constructor(public readonly log: Logging, config: PlatformConfig, public readonly api: API) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.cfg = config as HmConfig;
    api.on('didFinishLaunching', () => {
      this.start().catch((e) => this.log.error(`Start fehlgeschlagen: ${(e as Error).message}`));
    });
    api.on('shutdown', () => {
      clearTimeout(this.discoverTimer);
      clearInterval(this.pollTimer);
      this.rpc?.stop().catch(() => undefined);
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  private async start(): Promise<void> {
    if (!this.cfg.ccuHost) {
      this.log.error('Kein "ccuHost" konfiguriert (IP-Adresse oder Hostname der CCU).');
      return;
    }
    const ifaces = INTERFACES.filter((i) => this.cfg[i.key] ?? i.key !== 'bidcosWired');
    this.rpc = new HmRpc(this.log, this.cfg.ccuHost, ifaces, this.cfg.localIp, this.cfg.callbackPort ?? 9190);
    this.rpc.on('event', (e: HmEvent) => this.handlers.get(e.address)?.onEvent(e.key, e.value));
    this.rpc.on('devicesChanged', () => this.scheduleDiscover(10_000));
    await this.rpc.start();
    await this.discover().catch((e) => {
      this.log.error(`Geräteerkennung fehlgeschlagen: ${(e as Error).message}`);
      this.scheduleDiscover(60_000);
    });
  }

  private scheduleDiscover(ms: number): void {
    clearTimeout(this.discoverTimer);
    this.discoverTimer = setTimeout(() => {
      this.discover().catch((e) => this.log.error(`Geräteerkennung fehlgeschlagen: ${(e as Error).message}`));
    }, ms);
  }

  private matches(list: string[] | undefined, ch: { ADDRESS: string; PARENT: string }): boolean {
    return !!list?.some((a) => {
      const n = norm(a);
      return n === ch.ADDRESS || n === ch.PARENT;
    });
  }

  private async discover(): Promise<void> {
    if (this.discovering || !this.rpc) return;
    this.discovering = true;
    let complete = true;
    const seen = new Set<string>();
    try {
      let names = new Map<string, string>();
      if (this.cfg.useReGaNames !== false) {
        names = await this.rpc.fetchChannelNames().catch((e) => {
          this.log.debug(`Kanalnamen nicht lesbar (${(e as Error).message}), nutze Adressen.`);
          return new Map<string, string>();
        });
      }
      for (const iface of this.rpc.interfaces) {
        let devices: HmDevice[];
        try {
          devices = await this.rpc.listDevices(iface);
        } catch (e) {
          complete = false;
          this.log.warn(`${iface.name}: Geräteliste nicht abrufbar (${(e as Error).message})`);
          continue;
        }
        const byAddr = new Map(devices.map((d) => [d.ADDRESS, d]));
        const virtualSeen = new Set<string>();
        for (const ch of devices.filter((d) => d.PARENT)) {
          const parent = byAddr.get(ch.PARENT);
          const override = this.cfg.serviceOverrides?.find((o) => o.type === `${parent?.TYPE}:${ch.TYPE}` && KINDS.includes(o.kind));
          const kind = override?.kind ?? KIND_BY_TYPE[ch.TYPE];
          if (!kind || this.matches(this.cfg.exclude, ch)) continue;
          if (this.cfg.include?.length && !this.matches(this.cfg.include, ch)) continue;
          let desc: HmParamsetDesc;
          try {
            desc = await this.rpc.getParamsetDescription(ch.ADDRESS);
          } catch (e) {
            complete = false;
            this.log.warn(`${ch.ADDRESS}: Parameterbeschreibung nicht lesbar (${(e as Error).message})`);
            continue;
          }
          if (!usable(kind, desc)) {
            if (override) this.log.warn(`${ch.ADDRESS}: serviceOverrides "${override.type}" -> ${kind}, aber der Kanal bietet dafür keine passenden Datenpunkte.`);
            continue;
          }
          // Mehrere virtuelle Empfängerkanäle je Gerät: nur den ersten automatisch einbinden (Rest über "include").
          if (ch.TYPE.endsWith('_VIRTUAL_RECEIVER') && !this.cfg.include?.length) {
            const k = `${ch.PARENT}:${kind}`;
            if (virtualSeen.has(k)) continue;
            virtualSeen.add(k);
          }
          seen.add(ch.ADDRESS);
          await this.attach(ch, parent, kind, desc, names.get(ch.ADDRESS));
        }
      }
      await this.discoverRega(names, seen);
      if (complete) {
        const stale = [...this.accessories.values()].filter((a) => !seen.has(a.context.address));
        for (const a of stale) {
          this.log.info(`Entferne Zubehör ${a.displayName} (nicht mehr vorhanden/ausgewählt)`);
          this.accessories.delete(a.UUID);
          this.handlers.delete(a.context.address);
        }
        if (stale.length) this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      } else {
        this.scheduleDiscover(60_000);
      }
      this.log.info(`${seen.size} Kanäle eingebunden.`);
    } finally {
      this.discovering = false;
    }
  }

  private async discoverRega(names: Map<string, string>, seen: Set<string>): Promise<void> {
    const items: { address: string; obj: string; name: string; type: string; ref: { ADDRESS: string; PARENT: string } }[] = [];
    for (const v of this.cfg.variables ?? []) {
      items.push({ address: `rega:var:${v}`, obj: v, name: v, type: 'REGA_VARIABLE', ref: { ADDRESS: v, PARENT: '' } });
    }
    for (const c of this.cfg.cuxdSwitches ?? []) {
      const n = norm(c);
      items.push({ address: `rega:cuxd:${n}`, obj: `CUxD.${n}.STATE`, name: names.get(n) || `CUxD ${n}`, type: 'CUXD_CHANNEL', ref: { ADDRESS: n, PARENT: n.split(':')[0] } });
    }
    for (const it of items) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${it.address}`);
      let accessory = this.accessories.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(it.name, uuid);
        this.accessories.set(uuid, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Neu: ${it.name} (${it.obj})`);
      }
      accessory.context = { address: it.address, type: it.type, kind: 'switch' };
      const ch: HmDevice = { ADDRESS: it.address, TYPE: it.type, PARENT: '', VERSION: 0 };
      const h = new RegaSwitchHandler(this, accessory, ch, undefined, {}, it.name);
      h.regaName = it.obj;
      h.style = this.matches(this.cfg.outlets, it.ref) ? 'outlet' : this.matches(this.cfg.lights, it.ref) ? 'light' : 'switch';
      h.init();
      this.handlers.set(it.address, h);
      seen.add(it.address);
    }
    if (items.length) {
      const secs = Math.max(5, this.cfg.pollInterval ?? 10);
      clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => {
        this.pollRega().catch(() => undefined);
      }, secs * 1000);
      await this.pollRega();
    }
  }

  pollSoon(): void {
    setTimeout(() => {
      this.pollRega().catch(() => undefined);
    }, 1500);
  }

  private async pollRega(): Promise<void> {
    if (this.polling || !this.rpc) return;
    const hs = [...this.handlers.values()].filter((h): h is RegaSwitchHandler => h instanceof RegaSwitchHandler);
    if (!hs.length) return;
    this.polling = true;
    try {
      const values = await this.rpc.regaRead(hs.map((h) => h.regaName));
      for (const h of hs) {
        const v = values.get(h.regaName);
        if (v !== undefined) h.onEvent('STATE', v === 'true' || v === '1');
      }
    } catch (e) {
      this.log.debug(`ReGa-Abfrage fehlgeschlagen: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  private async attach(ch: HmDevice, parent: HmDevice | undefined, kind: Kind, desc: HmParamsetDesc, hmName?: string): Promise<void> {
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${ch.ADDRESS}`);
    const name = hmName || `${parent?.TYPE ?? ch.TYPE} ${ch.ADDRESS}`;
    let accessory = this.accessories.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      this.accessories.set(uuid, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`Neu: ${name} (${ch.ADDRESS}, ${kind})`);
    } else if (accessory.displayName !== name) {
      accessory.displayName = name;
      this.api.updatePlatformAccessories([accessory]);
    }
    accessory.context = { address: ch.ADDRESS, type: ch.TYPE, kind };

    const args = [this, accessory, ch, parent, desc, name] as const;
    let handler: BaseHandler;
    switch (kind) {
      case 'switch': {
        const h = new SwitchHandler(...args);
        h.style = this.matches(this.cfg.outlets, ch) ? 'outlet' : this.matches(this.cfg.lights, ch) ? 'light' : 'switch';
        handler = h;
        break;
      }
      case 'dimmer': handler = new DimmerHandler(...args); break;
      case 'blind': {
        const h = new BlindHandler(...args);
        h.style = this.matches(this.cfg.windows, ch) ? 'window' : 'blind';
        handler = h;
        break;
      }
      case 'contact': handler = new ContactHandler(...args); break;
      case 'thermostat': handler = new ThermostatHandler(...args); break;
    }
    handler.init();
    this.handlers.set(ch.ADDRESS, handler);
    await handler.refresh().catch((e) => this.log.warn(`${name}: Initialwerte nicht lesbar (${(e as Error).message})`));
  }
}
