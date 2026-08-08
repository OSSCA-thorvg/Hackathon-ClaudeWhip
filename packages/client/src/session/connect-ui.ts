/**
 * Bridge server connection UI — the top bar. Under the terminal theme it looks like a single
 * shell command line:
 *
 *     ❯ claudewhip --connect ws://localhost:8787 [connect]   [disconnected]
 *
 * That is, an address field + a connect toggle button + a status readout, and nothing else —
 * only the look is shell-like, the behavior is unchanged.
 *
 * This is "the human end of the server boundary". It calls the adapter directly (connect/disconnect),
 * but state comes back the other way **only through the `server_connection_changed` bus event** —
 * because transitions the UI did not initiate, such as reconnect backoff, must show up just the same.
 *
 * The markup lives in index.html (same rule as the HUD: static overlays in HTML, only the dynamic
 * parts in JS). The default address is built here from BRIDGE_PORT — never hardcode the port into HTML.
 */
import { BRIDGE_PORT, type EventBus, type ServerConnectionState } from '@claudewhip/shared';
import type { ServerConnection } from './ws-adapter.js';

/** Just a default — when opened from GitHub Pages the user edits it to their own machine's address */
const DEFAULT_BRIDGE_URL = `ws://localhost:${BRIDGE_PORT}`;

/** Status text wrapped in brackets like shell output. styles.css picks the color from data-state */
const STATUS_TEXT: Record<ServerConnectionState, string> = {
  disconnected: '[disconnected]',
  connecting: '[connecting…]',
  connected: '[connected]',
  error: '[failed]',
};

const BUTTON_TEXT: Record<ServerConnectionState, string> = {
  disconnected: '[connect]',
  connecting: '[cancel]',
  connected: '[disconnect]',
  error: '[retry]',
};

export interface ConnectUiInit {
  bus: EventBus;
  connection: ServerConnection;
  /** The container holding the top bar markup (#overlay) */
  root: HTMLElement;
}

/** @returns teardown function (unsubscribes) */
export function mountConnectUi(init: ConnectUiInit): () => void {
  const { bus, connection, root } = init;

  const bar = requireIn<HTMLElement>(root, '.connect-bar');
  const input = requireIn<HTMLInputElement>(bar, '.connect-bar__input');
  const button = requireIn<HTMLButtonElement>(bar, '.connect-bar__button');
  const text = requireIn<HTMLElement>(bar, '.connect-bar__text');

  // Both the value and the placeholder are set here — shared's BRIDGE_PORT is the only source for
  // the port, so keeping a second copy of the address in HTML would silently go stale when the port changes
  input.value = DEFAULT_BRIDGE_URL;
  input.placeholder = DEFAULT_BRIDGE_URL;

  const submit = (): void => {
    const url = input.value.trim();
    if (url === '') {
      input.focus();
      return;
    }
    connection.connect(url);
  };

  const onButtonClick = (): void => {
    // while connecting/connected, the toggle means cancel/disconnect
    if (connection.state === 'connecting' || connection.state === 'connected') {
      connection.disconnect();
    } else {
      submit();
    }
    // if focus stays on the button, Space (the whip) presses the button again — hand focus back to the game
    button.blur();
  };

  const onInputKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submit();
    input.blur();
  };

  const render = (state: ServerConnectionState): void => {
    text.textContent = STATUS_TEXT[state];
    button.textContent = BUTTON_TEXT[state];
    // editing the address while attached is meaningless (you have to disconnect first)
    input.disabled = state === 'connected' || state === 'connecting';
    bar.dataset['state'] = state;
  };

  button.addEventListener('click', onButtonClick);
  input.addEventListener('keydown', onInputKeyDown);
  const unsubscribe = bus.subscribe('server_connection_changed', (ev) => render(ev.payload.state));

  render(connection.state);

  return () => {
    button.removeEventListener('click', onButtonClick);
    input.removeEventListener('keydown', onInputKeyDown);
    unsubscribe();
  };
}

function requireIn<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`connect UI element missing: ${selector}`);
  return el;
}
