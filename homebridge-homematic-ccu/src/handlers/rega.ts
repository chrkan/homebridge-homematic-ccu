import { SwitchHandler } from './switch';

/** Schalter für Systemvariablen und CUxD-Kanäle: Lesen per Polling, Schreiben per ReGa-Script. */
export class RegaSwitchHandler extends SwitchHandler {
  regaName = '';

  async refresh(): Promise<void> {
    // Werte kommen vom Poller der Plattform.
  }

  protected async write(_key: string, value: number | boolean): Promise<void> {
    try {
      await this.platform.rpc!.regaSet(this.regaName, Boolean(value));
    } catch (e) {
      this.platform.log.error(`${this.name}: Schreiben fehlgeschlagen: ${(e as Error).message}`);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.platform.pollSoon();
  }
}
