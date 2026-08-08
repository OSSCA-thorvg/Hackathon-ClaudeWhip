/**
 * ThorVG initialization singleton.
 *
 * Two pitfalls (CLAUDE.md):
 *  - The default WASM loading path is the unpkg CDN. A `?url` import + locateFile forces
 *    the local bundle.
 *  - The renderer is decided once per page in init() (it cannot be changed per canvas).
 *
 * With a single canvas the reason to prefer 'sw' (each canvas consumes a WebGL context →
 * the browser's cap) went away. Since the whole screen is redrawn every frame, 'gl' is the
 * right choice.
 * If 'gl' initialization fails we fall back to 'sw' rather than killing the demo.
 *
 * Which renderer was actually obtained is not tracked separately here — `Canvas.renderer`
 * is the runtime fact, so that side (Stage.renderer) is the single source of truth.
 */
import ThorVG from '@thorvg/webcanvas';
import type { RendererType, ThorVGNamespace } from '@thorvg/webcanvas';
import wasmUrl from '@thorvg/webcanvas/dist/thorvg.wasm?url';

const PREFERRED_RENDERER: RendererType = 'gl';
const FALLBACK_RENDERER: RendererType = 'sw';

let pending: Promise<ThorVGNamespace> | null = null;

export function initThorVG(): Promise<ThorVGNamespace> {
  // The WASM loading path (locateFile) must be identical across both attempts — build it in one place
  const tryInit = (renderer: RendererType): Promise<ThorVGNamespace> =>
    ThorVG.init({ renderer, locateFile: () => wasmUrl });

  pending ??= tryInit(PREFERRED_RENDERER).catch((error: unknown) => {
    // We only land here in environments that cannot obtain a WebGL context (remote desktop, headless, etc.)
    console.warn('[render] gl renderer init failed, falling back to sw', error);
    return tryInit(FALLBACK_RENDERER);
  });
  return pending;
}
