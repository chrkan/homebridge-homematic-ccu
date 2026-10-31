import { BaseHandler } from './base';

export type SwitchStyle = 'switch' | 'outlet' | 'light';

export class SwitchHandler extends BaseHandler {
  private svc!: import('homebridge').Service;
  style: SwitchStyle = 'switch';

  protected setup(): void {
    const type = { switch: this.S.Switch, outlet: this.S.Outlet, light: this.S.Lightbulb }[this.style];
    this.svc = this.accessory.getService(type) ?? this.accessory.addService(type, this.name);
    this.svc.setCharacteristic(this.C.Name, this.name);
    this.svc
      .getCharacteristic(this.C.On)
      .onGet(() => Boolean(this.need('STATE')))
      .onSet((v) => this.write('STATE', Boolean(v)));
    if (this.style === 'outlet') this.svc.updateCharacteristic(this.C.OutletInUse, true);
    this.prune([this.svc]);
  }

  protected update(key: string, value: unknown): void {
    if (key === 'STATE') this.svc.updateCharacteristic(this.C.On, Boolean(value));
  }
}
