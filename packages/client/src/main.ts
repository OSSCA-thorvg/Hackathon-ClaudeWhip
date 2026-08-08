/**
 * Client entry point — wiring only. Components talk to each other exclusively over the EventBus.
 *
 * **The server is optional.** At boot there are zero sessions, and the player can still move
 * and crack the whip in that state. Targets only appear once the user connects to a bridge
 * address from the top bar. So there is no such thing here as a "session list at boot time" —
 * membership arrives entirely as events (the old synchronous fetchCached boot only ever worked
 * against the mock adapter, so it is gone).
 *
 * Boot order:
 * 0. Inject label typography metrics from render/layout.ts as CSS variables
 * 1. Create core/bus (main-thread LocalTransport + logic-worker PortTransport)
 * 2. Init render/thorvg → create the single-canvas Stage (zero targets)
 * 3. Start the logic worker (hand it the bus port + stage geometry over the control channel)
 * 4. Subscribe to session snapshots — reconcile → update stage membership + worker geometry
 * 5. Server connection adapter + top connect UI (does NOT auto-connect)
 * 6. Bind the keyboard → start the rAF render loop
 */
import './styles.css';
import type { PlayerState, TargetState } from '@claudewhip/shared';
import { Bus, PortTransport } from './core/bus/index.js';
import type { ClaudeWhipDebug, DebugLogEntry } from './debug-handle.js';
import type { WorkerControlMessage } from './game/protocol.js';
import { bindKeyboard } from './input/keyboard.js';
import { LABEL_FONT_SIZE_PX, LABEL_GAP_PX, LABEL_LINE_HEIGHT_PX } from './render/layout.js';
import { startRenderLoop } from './render/render-loop.js';
import { Stage } from './render/stage.js';
import { initThorVG } from './render/thorvg.js';
import { mountConnectUi } from './session/connect-ui.js';
import { createServerConnection, type ServerConnection } from './session/ws-adapter.js';

async function boot(): Promise<void> {
  const canvasEl = requireElement<HTMLCanvasElement>('#stage-canvas');
  const overlayEl = requireElement<HTMLElement>('#overlay');

  // 0. Inject the label typography metrics from layout.ts — the :root values in styles.css are
  //    only pre-paint placeholders; layout.ts is the single source of truth. The label's line
  //    height and gap are geometry, not CSS decoration: the labelY computation (layout.ts) and
  //    the character budget (target-node.ts) use the same values, so editing only the CSS makes
  //    labels drift off the characters or fold paths at the wrong place.
  //    (Column width is no longer pushed down to CSS — the canvas draws the session columns now)
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--label-font-size', `${LABEL_FONT_SIZE_PX}px`);
  rootStyle.setProperty('--label-line-height', `${LABEL_LINE_HEIGHT_PX}px`);
  rootStyle.setProperty('--label-gap', `${LABEL_GAP_PX}px`);
  mountLoginLine();

  // 1. Bus
  const bus = new Bus('main');

  // 2. Rendering — the whole play area is one canvas, characters are scene nodes inside it
  const tvg = await initThorVG();
  const stage = await Stage.create({ tvg, canvasEl, overlayEl });
  console.info(`[render] thorvg ${tvg.version} · renderer=${stage.renderer}`);

  // 3. Logic worker — the bus gets a dedicated MessageChannel, geometry goes over the control
  //    channel
  const worker = new Worker(new URL('./game/logic.worker.ts', import.meta.url), {
    type: 'module',
  });
  const channel = new MessageChannel();
  bus.addTransport(new PortTransport(channel.port1));

  const initMessage: WorkerControlMessage = {
    type: 'init',
    port: channel.port2,
    geometry: stage.geometry(),
  };
  worker.postMessage(initMessage, [channel.port2]);

  /**
   * The worker cannot see the DOM — whenever the slots change, main has to tell it the new
   * coordinates. Re-sending is safe because the worker's `withGeometry` preserves the reaction
   * progress of targets that are still alive.
   */
  const sendGeometry = (): void => {
    const message: WorkerControlMessage = { type: 'geometry', geometry: stage.geometry() };
    worker.postMessage(message);
  };

  // 4. Session lifecycle — only re-send geometry when stage membership actually changed.
  //    The stage side is async (Lottie loading), so ordering is guaranteed by Stage's queue.
  const applyMembership = (changed: Promise<boolean>): void => {
    void changed.then((didChange) => {
      if (didChange) sendGeometry();
    });
  };

  //    There is **exactly one** membership path: the snapshot. The server always sends a fresh
  //    snapshot whenever any session comes or goes (session-monitor's change signature includes
  //    the session ids) — meaning session_started/ended merely restate the same fact, and
  //    driving membership off them too would run the Stage sync and the geometry re-send twice
  //    every time. Both events stay in the contract and keep being published by the server
  //    (they are the signal other consumers use to learn *what* happened).
  bus.subscribe('session_snapshot', (ev) =>
    applyMembership(stage.syncSessions(ev.payload.sessions)),
  );

  // 5. Server boundary — the user initiates the connection (no auto-connect)
  const connection = createServerConnection(bus);
  mountConnectUi({ bus, connection, root: overlayEl });
  bus.subscribe('server_connection_changed', (ev) => {
    const { state, url } = ev.payload;
    console.info(`[session] server ${state}${url === undefined ? '' : ` ${url}`}`);
  });

  // Resize: only the layout needs recomputing, membership is unaffected
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      stage.resize();
      sendGeometry();
    }, 100);
  });

  // 6. Input + render loop
  bindKeyboard(bus);
  startRenderLoop({ bus, stage });

  exposeDevHandle(bus, stage, connection);
}

/**
 * Dev-build-only debug handle (`window.__claudewhip`). It does not survive into the production
 * bundle. The console and E2E need to inspect real events and state instead of "judging by
 * looking at the screen" — the canvas cannot be introspected through the DOM and the simulation
 * lives inside the worker.
 *
 * The **shape** of the handle is owned by `ClaudeWhipDebug` in debug-handle.ts — E2E looks at
 * the same type, so `pnpm typecheck` catches it when the composition here changes (it used to
 * be hand-copied on both sides).
 */
function exposeDevHandle(bus: Bus, stage: Stage, connection: ServerConnection): void {
  if (!import.meta.env.DEV) return;

  const log: DebugLogEntry[] = [];
  const names = [
    'session_snapshot',
    'session_started',
    'session_ended',
    'target_hit',
    'target_flinch',
    'server_connection_changed',
  ] as const;
  for (const name of names) {
    bus.subscribe(name, (ev) => {
      log.push({ name: ev.name, payload: ev.payload, ts: ev.meta.ts });
      if (log.length > 100) log.shift();
    });
  }

  let player: PlayerState | null = null;
  let targets: TargetState[] = [];
  bus.subscribe(
    'game_state_updated',
    (ev) => {
      player = ev.payload.player;
      targets = ev.payload.targets;
    },
    { coalesce: { maxWaitMs: 50 } },
  );

  const handle: ClaudeWhipDebug = {
    bus,
    stage,
    connection,
    log,
    state: () => ({
      player,
      targets,
      sessionIds: [...stage.targets.keys()],
      // Camera/culling happen inside the canvas, so the DOM can't confirm them — verify here
      render: stage.stats(),
    }),
  };
  (window as unknown as Record<string, unknown>)['__claudewhip'] = handle;
}

/**
 * One line of terminal flavor (`Last login: …`). Prints the boot time in shell login-banner
 * format — decoration that makes the top-left of the screen read like a freshly opened terminal.
 */
function mountLoginLine(): void {
  const el = document.querySelector<HTMLElement>('.hud__login');
  if (!el) return;
  const now = new Date();
  const weekday = now.toLocaleDateString('en-US', { weekday: 'short' });
  const month = now.toLocaleDateString('en-US', { month: 'short' });
  // The shell banner pads the day with a space (`Aug  2`), not with a zero
  const day = String(now.getDate()).padStart(2, ' ');
  el.textContent =
    `Last login: ${weekday} ${month} ${day} ${now.toTimeString().slice(0, 8)} on ttys001`;
}

function requireElement<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`layout element missing: ${selector}`);
  return el;
}

void boot();
