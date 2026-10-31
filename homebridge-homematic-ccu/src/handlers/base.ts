import type { PlatformAccessory, Service } from 'homebridge';
import type { HomematicPlatform } from '../platform';
import type { HmDevice, HmParamsetDesc } from '../rpc';
import { isWritable } from '../rpc';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export abstract class BaseHandler {
  protected readonly state: Record<string, unknown> = {};
  protected get hap() {
    return this.platform.api.hap;
  }
  protected get C() {
    return this.platform.api.hap.Characteristic;
  }
  protected get S() {
    return this.platform.api.hap.Service;
  }

  constructor(
    protected readonly platform: HomematicPlatform,
    protected readonly accessory: PlatformAccessory,
    protected readonly channel: HmDevice,
    protected readonly parent: HmDevice | undefined,
    protected readonly desc: HmParamsetDesc,
    protected readonly name: string,
  ) {}

  protected abstract setup(): void;
  protected abstract update(key: string, value: unknown): void;

  init(): void {
    const info = this.accessory.getService(this.S.AccessoryInformation) ?? this.accessory.addService(this.S.AccessoryInformation);
    info
      .setCharacteristic(this.C.Manufacturer, 'eQ-3 / ELV')
      .setCharacteristic(this.C.Model, this.parent?.TYPE ?? this.channel.TYPE)
      .setCharacteristic(this.C.SerialNumber, this.channel.ADDRESS);
    if (this.parent?.FIRMWARE) info.setCharacteristic(this.C.FirmwareRevision, this.parent.FIRMWARE);
    this.setup();
  }

  /** Entfernt alle Services, die nicht (mehr) zu diesem Kanal gehören (z. B. nach Wechsel Schalter -> Steckdose). */
  protected prune(keep: Service[]): void {
    for (const s of [...this.accessory.services]) {
      if (s.UUID === this.S.AccessoryInformation.UUID) continue;
      if (!keep.includes(s)) this.accessory.removeService(s);
    }
  }

  onEvent(key: string, value: unknown): void {
    this.state[key] = value;
    try {
      this.update(key, value);
    } catch (e) {
      this.platform.log.debug(`${this.name}: Event ${key} nicht verarbeitet: ${(e as Error).message}`);
    }
  }

  async refresh(): Promise<void> {
    const values = await this.platform.rpc!.getValues(this.channel.ADDRESS);
    for (const [k, v] of Object.entries(values)) this.onEvent(k, v);
  }

  protected writable(key: string): boolean {
    return isWritable(this.desc, key);
  }

  protected need<T>(key: string): T {
    const v = this.state[key];
    if (v === undefined) throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    return v as T;
  }

  protected async write(key: string, value: number | boolean): Promise<void> {
    try {
      await this.platform.rpc!.setValue(this.channel.ADDRESS, key, value);
    } catch (e) {
      this.platform.log.error(`${this.name}: Schreiben von ${key}=${value} fehlgeschlagen: ${(e as Error).message}`);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }
}
