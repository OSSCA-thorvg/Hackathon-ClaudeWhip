/**
 * Keyboard → typed events. Knows nothing about the game rules (hit detection and movement
 * distances are entirely the logic worker's business).
 *
 * Bindings:
 *   ← / → / ↑ / ↓ : move while held (keydown=pressed:true, keyup=pressed:false)
 *   Space         : whip swing (key repeat ignored — holding it down still swings once)
 *
 * While a text entry (the server address bar, etc.) has focus we **accept no new input** — the
 * character must not run around while you are typing an address. Conversely, keyup is handled
 * regardless of focus: if you click into the input field while holding a key, the keyup goes
 * there, and ignoring it would leave that key stuck down forever.
 */
import type { Direction, EventBus } from '@claudewhip/shared';

const MOVE_KEYS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

const SWING_KEY = 'Space';

export function bindKeyboard(bus: EventBus, target: Window = window): () => void {
  const held = new Set<string>();

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isTextEntry(e.target)) return;
    const direction = MOVE_KEYS[e.code];
    if (direction) {
      e.preventDefault();
      // Do not spam the same event via key repeat
      if (held.has(e.code)) return;
      held.add(e.code);
      bus.broadcast('player_move', { direction, pressed: true });
      return;
    }
    if (e.code === SWING_KEY) {
      e.preventDefault();
      if (e.repeat) return; // ignore space-bar key repeat
      bus.broadcast('whip_swing', {});
    }
  };

  // Let the keyup of a key that was never pressed pass through (e.g. pressing and releasing an
  // arrow key inside the input field)
  const onKeyUp = (e: KeyboardEvent): void => {
    const direction = MOVE_KEYS[e.code];
    if (!direction || !held.has(e.code)) return;
    e.preventDefault();
    held.delete(e.code);
    bus.broadcast('player_move', { direction, pressed: false });
  };

  // Losing focus would otherwise leave held keys stuck down forever
  const onBlur = (): void => {
    for (const code of held) {
      const direction = MOVE_KEYS[code];
      if (direction) bus.broadcast('player_move', { direction, pressed: false });
    }
    held.clear();
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);

  return () => {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
    target.removeEventListener('blur', onBlur);
  };
}

/** Did the event originate from an element that accepts text (somewhere game input must not
 * be intercepted)? */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
