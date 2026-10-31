import { BaseHandler, sleep } from './base';

export class DimmerHandler extends BaseHandler {
  private svc!: import('homebridge').Service;
  private lastLevel = 1;
  private brightnessSetAt = 0;

  protected setup(): void {
    this.svc = this.accessory.getService(this.S.Lightbulb) ?? this.accessory.addService(this.S.Lightbulb, this.name);
    this.svc.setCharacteristic(this.C.Name, this.name);
    this.svc
      .getCharacteristic(this.C.On)
      .onGet(() => Number(this.need('LEVEL')) > 0)
      .onSet(async (v) => {
        const started = Date.now();
        // HomeKit sendet bei "An + Helligkeit" zwei Befehle; kurz warten, damit nicht erst auf 100 % und dann zurück geschaltet wird.
        if (v) await sleep(120);
        if (this.brightnessSetAt >= started) return;
        await this.write('LEVEL', v ? this.lastLevel : 0);
      });
    this.svc
      .getCharacteristic(this.C.Brightness)
      .onGet(() => Math.round(Number(this.need('LEVEL')) * 100))
      .onSet(async (v) => {
        this.brightnessSetAt = Date.now();
        const level = Math.min(1, Math.max(0, Number(v) / 100));
        if (level > 0) this.lastLevel = level;
        await this.write('LEVEL', level);
      });
    this.prune([this.svc]);
  }

  protected update(key: string, value: unknown): void {
    if (key !== 'LEVEL') return;
    const level = Math.min(1, Math.max(0, Number(value)));
    if (level > 0) this.lastLevel = level;
    this.svc.updateCharacteristic(this.C.On, level > 0);
    this.svc.updateCharacteristic(this.C.Brightness, Math.round(level * 100));
  }
}
