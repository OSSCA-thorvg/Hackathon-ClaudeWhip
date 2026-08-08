/**
 * MessagePort transport — main thread ↔ logic worker.
 * The worker's default channel (worker.postMessage) is reserved for control messages such as
 * init/geometry, and bus traffic is split onto a dedicated MessageChannel (mixing the two makes
 * debugging hell).
 */
import type { BusEnvelope, BusTransport } from './transport.js';

/** Tag so that other messages flowing over the same port can be ignored */
const WIRE_TAG = 'claudewhip/bus' as const;

/** Wire frame = envelope + tag. Do not redeclare the envelope fields (the contract lives in transport.ts) */
interface WireFrame extends BusEnvelope {
  tag: typeof WIRE_TAG;
}

function isWireFrame(data: unknown): data is WireFrame {
  return typeof data === 'object' && data !== null && (data as { tag?: unknown }).tag === WIRE_TAG;
}

export class PortTransport implements BusTransport {
  readonly #port: MessagePort;
  #receive: ((env: BusEnvelope) => void) | null = null;

  constructor(port: MessagePort) {
    this.#port = port;
    this.#port.onmessage = (e: MessageEvent<unknown>) => {
      if (!isWireFrame(e.data)) return;
      // strip only the tag; what remains is exactly the envelope
      const { tag: _tag, ...env } = e.data;
      this.#receive?.(env);
    };
    // assigning onmessage starts the port implicitly, but being explicit is harmless
    this.#port.start();
  }

  send(env: BusEnvelope): void {
    const frame: WireFrame = { ...env, tag: WIRE_TAG };
    // the payload must be structured-cloneable (contract in shared/events.ts)
    this.#port.postMessage(frame);
  }

  onReceive(cb: (env: BusEnvelope) => void): void {
    this.#receive = cb;
  }
}
