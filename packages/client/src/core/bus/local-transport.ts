/**
 * Same-thread transport — a loopback where `send` comes straight back through the receive callback.
 * Bus routes local dispatch through a transport as well, so that there is exactly one broadcast path.
 */
import type { BusEnvelope, BusTransport } from './transport.js';

export class LocalTransport implements BusTransport {
  #receive: ((env: BusEnvelope) => void) | null = null;

  send(env: BusEnvelope): void {
    this.#receive?.(env);
  }

  onReceive(cb: (env: BusEnvelope) => void): void {
    this.#receive = cb;
  }
}
