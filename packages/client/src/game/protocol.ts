/**
 * Logic worker control-channel protocol (main → worker, the default worker.postMessage
 * channel).
 *
 * Game events flow only over the EventBus on a dedicated MessagePort (PortTransport).
 * This channel carries just two things: "what is needed before the bus is attached" and "DOM
 * geometry the worker cannot see" — the worker has no DOM access, so the main thread has to
 * tell it the stage/slot coordinates.
 *
 * The geometry types live here too — they are a contract shared by the main thread (which
 * measures) and the worker (which consumes), so this file, not any simulation-internal type,
 * is the single source of truth.
 */

/**
 * All coordinates are **world** px (origin at the world's top-left, y grows downward).
 * The world can be taller than the viewport — the camera that picks the visible slice lives
 * only on the render side (render/camera.ts) and the worker does not know it exists.
 */
export interface SlotGeometry {
  sessionId: string;
  slot: number;
  /** Target body center (world) */
  centerX: number;
  centerY: number;
}

export interface StageGeometry {
  stageWidth: number;
  /**
   * World height — the clamp range for vertical movement (the worker cannot see the DOM, so
   * the main thread measures it).
   * This is NOT the viewport height: when more sessions pile up than fit on screen this value
   * grows larger, and the player can walk down past the bottom of the screen (the camera
   * follows).
   */
  worldHeight: number;
  /**
   * Player spawn position (world body center). It used to be a "fixed floor y", but the
   * position is now owned by the simulation and these values are used only as the initial
   * position.
   * It is the same value as the renderer's first placement (render/stage.ts) — the source is
   * one place, render/layout.ts.
   */
  playerCenterX: number;
  playerCenterY: number;
  slots: SlotGeometry[];
}

export interface WorkerInitMessage {
  type: 'init';
  /** One end of the bus-dedicated MessageChannel (handed over via transfer) */
  port: MessagePort;
  geometry: StageGeometry;
}

export interface WorkerGeometryMessage {
  type: 'geometry';
  geometry: StageGeometry;
}

export type WorkerControlMessage = WorkerInitMessage | WorkerGeometryMessage;
