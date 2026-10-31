import { BaseHandler } from './base';
import { firstKey } from '../rpc';

export class ThermostatHandler extends BaseHandler {
  private svc!: import('homebridge').Service;
  private tempKey?: string;
  private humKey?: string;
  private levelKey?: string;
  private setKey?: string;
  private min = 4.5;
  private max = 30.5;
  private canMode = false; // CONTROL_MODE schreibbar (HmIP)
  private canAutoManu = false; // AUTO_MODE/MANU_MODE (HM-CC-RT-DN, HM-CC-TC)
  private targetTimer?: NodeJS.Timeout;
  private lastTarget = 20;

  protected setup(): void {
    const d = this.desc;
    this.tempKey = firstKey(d, ['ACTUAL_TEMPERATURE', 'TEMPERATURE']);
    this.humKey = firstKey(d, ['HUMIDITY', 'ACTUAL_HUMIDITY']);
    this.levelKey = firstKey(d, ['LEVEL', 'VALVE_STATE']);
    this.setKey = ['SET_POINT_TEMPERATURE', 'SET_TEMPERATURE'].find((k) => this.writable(k));
    this.canMode = this.writable('CONTROL_MODE');
    this.canAutoManu = this.writable('AUTO_MODE') && this.writable('MANU_MODE');
    const sp = d[this.setKey ?? 'MANU_MODE'];
    if (typeof sp?.MIN === 'number') this.min = sp.MIN;
    if (typeof sp?.MAX === 'number') this.max = sp.MAX;

    const C = this.C;
    this.svc = this.accessory.getService(this.S.Thermostat) ?? this.accessory.addService(this.S.Thermostat, this.name);
    this.svc.setCharacteristic(C.Name, this.name);
    this.svc.updateCharacteristic(C.TemperatureDisplayUnits, C.TemperatureDisplayUnits.CELSIUS);

    const modes = [C.TargetHeatingCoolingState.OFF, C.TargetHeatingCoolingState.HEAT];
    if (this.canMode || this.canAutoManu) modes.push(C.TargetHeatingCoolingState.AUTO);

    this.svc.getCharacteristic(C.CurrentTemperature).setProps({ minValue: -40, maxValue: 80 }).onGet(() => this.need<number>(this.tempKey ?? 'ACTUAL_TEMPERATURE'));
    this.svc
      .getCharacteristic(C.TargetTemperature)
      .setProps({ minValue: this.min, maxValue: this.max, minStep: 0.5 })
      .onGet(() => this.clampTarget(this.need<number>(this.setKey ?? 'SET_POINT_TEMPERATURE')))
      .onSet((v) => this.onSetTarget(Number(v)));
    this.svc.getCharacteristic(C.CurrentHeatingCoolingState).setProps({ validValues: [0, 1] }).onGet(() => this.currentState());
    this.svc
      .getCharacteristic(C.TargetHeatingCoolingState)
      .setProps({ validValues: modes })
      .onGet(() => this.targetState())
      .onSet((v) => this.onSetMode(Number(v)));
    if (this.humKey) this.svc.getCharacteristic(C.CurrentRelativeHumidity).onGet(() => this.need<number>(this.humKey!));
    this.prune([this.svc]);
  }

  private clampTarget(t: number): number {
    return Math.min(this.max, Math.max(this.min, t));
  }

  private mode(): unknown {
    return this.state.SET_POINT_MODE ?? this.state.CONTROL_MODE;
  }

  private currentState(): number {
    if (!this.levelKey || this.state[this.levelKey] === undefined) return 0;
    return Number(this.state[this.levelKey]) > 0 ? 1 : 0;
  }

  private targetState(): number {
    const T = this.C.TargetHeatingCoolingState;
    if (this.mode() === 0 && (this.canMode || this.canAutoManu)) return T.AUTO;
    const sp = this.setKey ? Number(this.state[this.setKey]) : NaN;
    if (!Number.isNaN(sp) && sp <= this.min) return T.OFF;
    return T.HEAT;
  }

  private async onSetMode(v: number): Promise<void> {
    const T = this.C.TargetHeatingCoolingState;
    if (v === T.OFF) {
      await this.writeSetpoint(this.min);
    } else if (v === T.AUTO) {
      if (this.canMode) await this.write('CONTROL_MODE', 0);
      else if (this.canAutoManu) await this.write('AUTO_MODE', true);
    } else if (v === T.HEAT) {
      const cur = this.setKey ? Number(this.state[this.setKey]) : NaN;
      const target = !Number.isNaN(cur) && cur > this.min ? cur : this.lastTarget;
      if (this.canMode) {
        await this.write('CONTROL_MODE', 1);
        if (Number.isNaN(cur) || cur <= this.min) await this.writeSetpoint(target);
      } else {
        await this.writeSetpoint(target);
      }
    }
  }

  private onSetTarget(v: number): Promise<void> {
    const t = this.clampTarget(v);
    if (t > this.min) this.lastTarget = t;
    // HomeKit sendet beim Ziehen des Reglers viele Werte -> nur den letzten senden.
    clearTimeout(this.targetTimer);
    return new Promise((resolve) => {
      this.targetTimer = setTimeout(() => {
        this.writeSetpoint(t).catch((e) => this.platform.log.error(`${this.name}: ${(e as Error).message}`));
      }, 800);
      resolve();
    });
  }

  private async writeSetpoint(t: number): Promise<void> {
    if (this.setKey) await this.write(this.setKey, t);
    else if (this.canAutoManu) await this.write('MANU_MODE', t);
  }

  protected update(key: string, value: unknown): void {
    const C = this.C;
    if (key === this.tempKey) this.svc.updateCharacteristic(C.CurrentTemperature, Number(value));
    if (key === this.humKey) this.svc.updateCharacteristic(C.CurrentRelativeHumidity, Number(value));
    if (key === this.levelKey) this.svc.updateCharacteristic(C.CurrentHeatingCoolingState, this.currentState());
    if (key === this.setKey) {
      const t = Number(value);
      if (t > this.min) this.lastTarget = t;
      this.svc.updateCharacteristic(C.TargetTemperature, this.clampTarget(t));
    }
    if (key === this.setKey || key === 'SET_POINT_MODE' || key === 'CONTROL_MODE') {
      this.svc.updateCharacteristic(C.TargetHeatingCoolingState, this.targetState());
    }
  }
}
