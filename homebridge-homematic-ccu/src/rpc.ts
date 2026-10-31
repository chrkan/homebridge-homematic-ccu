import { EventEmitter } from 'node:events';
import os from 'node:os';
import xmlrpc from 'homematic-xmlrpc';
import type { Logging } from 'homebridge';

export interface HmInterfaceDef {
  key: 'bidcosRf' | 'hmipRf' | 'bidcosWired';
  name: string;
  port: number;
}

export const INTERFACES: HmInterfaceDef[] = [
  { key: 'bidcosRf', name: 'BidCos-RF', port: 2001 },
  { key: 'hmipRf', name: 'HmIP-RF', port: 2010 },
  { key: 'bidcosWired', name: 'BidCos-Wired', port: 2000 },
];

export interface HmDevice {
  ADDRESS: string;
  TYPE: string;
  PARENT: string;
  CHILDREN?: string[];
  FIRMWARE?: string;
  VERSION: number;
}

export interface HmParamDesc {
  TYPE: string;
  OPERATIONS: number;
  MIN?: number;
  MAX?: number;
  VALUE_LIST?: string[];
}
export type HmParamsetDesc = Record<string, HmParamDesc>;

export interface HmEvent {
  iface: string;
  address: string;
  key: string;
  value: unknown;
}

export const isWritable = (d: HmParamsetDesc, key: string): boolean => !!d[key] && (d[key].OPERATIONS & 2) !== 0;
export const firstKey = (d: HmParamsetDesc, keys: string[]): string | undefined => keys.find((k) => k in d);

const CALL_TIMEOUT_MS = 15_000;
const WATCHDOG_INTERVAL_MS = 2 * 60_000;
const SILENCE_LIMIT_MS = 5 * 60_000;

export class HmRpc extends EventEmitter {
  public readonly interfaces: HmInterfaceDef[];
  private readonly clients = new Map<string, ReturnType<typeof xmlrpc.createClient>>();
  private readonly lastSeen = new Map<string, number>();
  private readonly known = new Map<string, { ADDRESS: string; VERSION: number }[]>();
  private readonly addrIface = new Map<string, HmInterfaceDef>();
  private readonly descCache = new Map<string, HmParamsetDesc>();
  private server?: ReturnType<typeof xmlrpc.createServer>;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  public readonly localIp: string;

  constructor(
    private readonly log: Logging,
    private readonly host: string,
    interfaces: HmInterfaceDef[],
    localIp: string | undefined,
    private readonly callbackPort: number,
  ) {
    super();
    this.interfaces = interfaces;
    this.localIp = localIp || HmRpc.detectLocalIp(host);
  }

  static detectLocalIp(host: string): string {
    const nets = Object.values(os.networkInterfaces()).flat().filter((n): n is os.NetworkInterfaceInfo => !!n && n.family === 'IPv4');
    const prefix = host.split('.').slice(0, 3).join('.') + '.';
    const same = nets.find((n) => n.address.startsWith(prefix));
    if (same) return same.address;
    const ext = nets.find((n) => !n.internal);
    return (ext ?? nets[0])?.address ?? '127.0.0.1';
  }

  private ifaceId(i: HmInterfaceDef): string {
    return `homebridge-hm-${i.name}`;
  }
  private ifaceById(id: unknown): HmInterfaceDef | undefined {
    return this.interfaces.find((i) => this.ifaceId(i) === id);
  }

  async start(): Promise<void> {
    await this.listen();
    for (const iface of this.interfaces) {
      await this.register(iface).catch((e) => this.log.warn(`${iface.name}: Anmeldung an der CCU fehlgeschlagen (${e.message}); neuer Versuch durch Watchdog.`));
    }
    this.timer = setInterval(() => this.watchdog(), WATCHDOG_INTERVAL_MS);
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      let up = false;
      const server = xmlrpc.createServer({ host: '0.0.0.0', port: this.callbackPort });
      this.server = server;
      server.on('listening', () => {
        up = true;
        this.log.info(`XML-RPC Callback lauscht auf ${this.localIp}:${this.callbackPort}`);
        resolve();
      });
      server.on('error', (e: Error) => (up ? this.log.error(`XML-RPC Server: ${e.message}`) : reject(e)));

      server.on('system.listMethods', (_e: unknown, _p: unknown[], cb: (e: null, v: unknown) => void) =>
        cb(null, ['event', 'listDevices', 'newDevices', 'deleteDevices', 'updateDevice', 'replaceDevice', 'readdedDevice', 'system.listMethods', 'system.multicall']));
      server.on('listDevices', (_e: unknown, p: unknown[], cb: (e: null, v: unknown) => void) => {
        const iface = this.ifaceById(p[0]);
        cb(null, (iface && this.known.get(iface.name)) || []);
      });
      server.on('event', (_e: unknown, p: unknown[], cb: (e: null, v: unknown) => void) => {
        this.handleCall('event', p);
        cb(null, '');
      });
      for (const m of ['newDevices', 'deleteDevices', 'updateDevice', 'replaceDevice', 'readdedDevice']) {
        server.on(m, (_e: unknown, p: unknown[], cb: (e: null, v: unknown) => void) => {
          this.handleCall(m, p);
          cb(null, '');
        });
      }
      server.on('system.multicall', (_e: unknown, p: unknown[], cb: (e: null, v: unknown) => void) => {
        const calls = (Array.isArray(p[0]) ? p[0] : []) as { methodName: string; params: unknown[] }[];
        for (const c of calls) this.handleCall(c.methodName, c.params ?? []);
        cb(null, calls.map(() => ''));
      });
    });
  }

  private handleCall(method: string, p: unknown[]): void {
    if (method === 'event') {
      const iface = this.ifaceById(p[0]);
      if (!iface) return;
      this.lastSeen.set(iface.name, Date.now());
      const [, address, key, value] = p as [unknown, string, string, unknown];
      if (key === 'PONG') return;
      this.emit('event', { iface: iface.name, address, key, value } satisfies HmEvent);
    } else if (['newDevices', 'deleteDevices', 'updateDevice', 'replaceDevice', 'readdedDevice'].includes(method)) {
      this.descCache.clear();
      this.emit('devicesChanged', method);
    }
  }

  private async register(iface: HmInterfaceDef): Promise<void> {
    await this.call(iface, 'init', [`http://${this.localIp}:${this.callbackPort}`, this.ifaceId(iface)]);
    this.lastSeen.set(iface.name, Date.now());
    this.log.debug(`${iface.name}: an der CCU angemeldet`);
  }

  private watchdog(): void {
    if (this.stopped) return;
    for (const iface of this.interfaces) {
      const age = Date.now() - (this.lastSeen.get(iface.name) ?? 0);
      if (age > SILENCE_LIMIT_MS) {
        this.log.warn(`${iface.name}: seit ${Math.round(age / 60000)} min keine Events, melde mich neu an der CCU an.`);
        this.register(iface).catch((e) => this.log.warn(`${iface.name}: Neuanmeldung fehlgeschlagen (${e.message})`));
      } else {
        this.call(iface, 'ping', [this.ifaceId(iface)]).catch(() => undefined);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all(
      this.interfaces.map((i) =>
        this.call(i, 'init', [`http://${this.localIp}:${this.callbackPort}`, '']).catch(() => undefined),
      ),
    );
    this.server?.httpServer.close();
  }

  call(iface: HmInterfaceDef, method: string, params: unknown[]): Promise<unknown> {
    let client = this.clients.get(iface.name);
    if (!client) {
      client = xmlrpc.createClient({ host: this.host, port: iface.port, path: '/' });
      this.clients.set(iface.name, client);
    }
    const c = client;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout bei ${method}`)), CALL_TIMEOUT_MS);
      c.methodCall(method, params, (err, val) => {
        clearTimeout(t);
        if (err) reject(err);
        else resolve(val);
      });
    });
  }

  async listDevices(iface: HmInterfaceDef): Promise<HmDevice[]> {
    const list = (await this.call(iface, 'listDevices', [])) as HmDevice[];
    this.known.set(iface.name, list.map((d) => ({ ADDRESS: d.ADDRESS, VERSION: d.VERSION })));
    for (const d of list) this.addrIface.set(d.ADDRESS, iface);
    return list;
  }

  private ifaceFor(address: string): HmInterfaceDef {
    const i = this.addrIface.get(address);
    if (!i) throw new Error(`Unbekannte Adresse ${address}`);
    return i;
  }

  async getParamsetDescription(address: string): Promise<HmParamsetDesc> {
    const hit = this.descCache.get(address);
    if (hit) return hit;
    const d = (await this.call(this.ifaceFor(address), 'getParamsetDescription', [address, 'VALUES'])) as HmParamsetDesc;
    this.descCache.set(address, d);
    return d;
  }

  async getValues(address: string): Promise<Record<string, unknown>> {
    return (await this.call(this.ifaceFor(address), 'getParamset', [address, 'VALUES'])) as Record<string, unknown>;
  }

  /** Schreibt einen Wert und wandelt ihn passend zum Parametertyp (FLOAT muss als double gesendet werden). */
  async setValue(address: string, key: string, value: number | boolean): Promise<void> {
    const desc = await this.getParamsetDescription(address);
    const type = desc[key]?.TYPE;
    let v: unknown = value;
    if (type === 'FLOAT') v = { explicitDouble: Number(value) };
    else if (type === 'INTEGER' || type === 'ENUM') v = Math.round(Number(value));
    else if (type === 'BOOL' || type === 'ACTION') v = Boolean(value);
    await this.call(this.ifaceFor(address), 'setValue', [address, key, v]);
  }

  /** Führt ein HM-Script auf der ReGa (Port 8181) aus und liefert die Ausgabe ohne XML-Anhang. */
  async rega(script: string): Promise<string> {
    const res = await fetch(`http://${this.host}:8181/tclrega.exe`, { method: 'POST', body: script, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`ReGa HTTP ${res.status}`);
    const text = new TextDecoder('iso-8859-1').decode(await res.arrayBuffer());
    const cut = text.indexOf('<xml>');
    return cut >= 0 ? text.slice(0, cut) : text;
  }

  private static checkName(n: string): void {
    if (!n || /["\\\r\n\t]/.test(n)) throw new Error(`Ungültiger Name für ReGa-Objekt: ${n}`);
  }

  /** Kanalnamen aus der ReGa. Optional; bei Fehler werden Adressen als Namen genutzt. */
  async fetchChannelNames(): Promise<Map<string, string>> {
    const out = await this.rega(
      'string id;\nforeach(id, dom.GetObject(ID_CHANNELS).EnumUsedIDs()) {\n  var c = dom.GetObject(id);\n  WriteLine(c.Address() + "\\t" + c.Name());\n}\n',
    );
    const map = new Map<string, string>();
    for (const line of out.split(/\r?\n/)) {
      const [addr, name] = line.split('\t');
      if (addr && name) map.set(addr.trim(), name.trim());
    }
    return map;
  }

  /** Liest den Zustand von Systemvariablen/Datenpunkten (z. B. "CUxD.CUX0200001:1.STATE") in einem Aufruf. */
  async regaRead(names: string[]): Promise<Map<string, string>> {
    names.forEach(HmRpc.checkName);
    const script = 'object o;\n' + names.map((n) => `o = dom.GetObject("${n}"); if (o) { WriteLine("${n}\\t" # o.State()); }`).join('\n');
    const map = new Map<string, string>();
    for (const line of (await this.rega(script)).split(/\r?\n/)) {
      const i = line.indexOf('\t');
      if (i > 0) map.set(line.slice(0, i), line.slice(i + 1).trim());
    }
    return map;
  }

  async regaSet(name: string, value: boolean): Promise<void> {
    HmRpc.checkName(name);
    const out = await this.rega(`object o = dom.GetObject("${name}");\nif (o) { o.State(${value}); WriteLine("ok"); } else { WriteLine("missing"); }`);
    if (!/^ok\s*$/m.test(out)) throw new Error(`"${name}" in der CCU nicht gefunden`);
  }
}
