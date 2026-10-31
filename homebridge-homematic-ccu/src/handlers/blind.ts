import { BaseHandler } from './base';

export class BlindHandler extends BaseHandler {
  private svc!: import('homebridge').Service;
  private moving = false;
  style: 'blind' | 'window' = 'blind';

  protected setup(): void {
    const type = this.style === 'window' ? this.S.Window : this.S.WindowCovering;
    this.svc = this.accessory.getService(type) ?? this.accessory.addService(type, this.name);
    this.svc.setCharacteristic(this.C.Name, this.name);
    const pos = () => Math.round(Math.min(1, Math.max(0, Number(this.need('LEVEL')))) * 100);
    this.svc.getCharacteristic(this.C.CurrentPosition).onGet(pos);
    this.svc.getCharacteristic(this.C.TargetPosition).onGet(pos).onSet((v) => this.write('LEVEL', Number(v) / 100));
    this.svc.getCharacteristic(this.C.PositionState).onGet(() => this.positionState());
    if (this.writable('STOP')) {
      this.svc.getCharacteristic(this.C.HoldPosition).onSet((v) => (v ? this.write('STOP', true) : undefined));
    }
    this.prune([this.svc]);
  }

  /** 0 = fährt zu, 1 = fährt auf, 2 = steht (HAP). */
  private positionState(): number {
    const act = this.state.ACTIVITY_STATE; // HmIP: 0 unbekannt, 1 hoch, 2 runter, 3 stabil
    if (act !== undefined) return act === 1 ? 1 : act === 2 ? 0 : 2;
    if (this.state.WORKING === true) {
      const dir = this.state.DIRECTION; // HM: 0 keine, 1 hoch, 2 runter
      return dir === 1 ? 1 : dir === 2 ? 0 : 2;
    }
    return 2;
  }

  protected update(key: string): void {
    if (!['LEVEL', 'ACTIVITY_STATE', 'WORKING', 'DIRECTION'].includes(key)) return;
    const state = this.positionState();
    this.moving = state !== 2;
    this.svc.updateCharacteristic(this.C.PositionState, state);
    if (this.state.LEVEL === undefined) return;
    const p = Math.round(Math.min(1, Math.max(0, Number(this.state.LEVEL))) * 100);
    this.svc.updateCharacteristic(this.C.CurrentPosition, p);
    if (!this.moving) this.svc.updateCharacteristic(this.C.TargetPosition, p);
  }
}
