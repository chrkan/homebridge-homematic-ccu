import { BaseHandler } from './base';

export class ContactHandler extends BaseHandler {
  private svc!: import('homebridge').Service;

  /** Fensterkontakt: STATE bool (true = offen); Griffsensor: STATE 0 zu, 1 gekippt, 2 offen. */
  private isOpen(v: unknown): boolean {
    return typeof v === 'number' ? v > 0 : Boolean(v);
  }

  protected setup(): void {
    this.svc = this.accessory.getService(this.S.ContactSensor) ?? this.accessory.addService(this.S.ContactSensor, this.name);
    this.svc.setCharacteristic(this.C.Name, this.name);
    this.svc
      .getCharacteristic(this.C.ContactSensorState)
      .onGet(() => (this.isOpen(this.need('STATE')) ? 1 : 0));
    this.prune([this.svc]);
  }

  protected update(key: string, value: unknown): void {
    if (key === 'STATE') this.svc.updateCharacteristic(this.C.ContactSensorState, this.isOpen(value) ? 1 : 0);
  }
}
