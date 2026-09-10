/**
 * How the backend tells the window something changed. Events flow one way,
 * backend → renderer, for cache invalidation only (spec §3): the watcher
 * noticing a `.ddd/` write, the scheduler finishing a fetch.
 *
 * Core never sees a window: main implements this with `webContents.send`,
 * tests with an array.
 */
export interface Emitter {
  emit(name: string, payload: unknown): void;
}

export interface RecordedEvent {
  name: string;
  payload: unknown;
}

/** For tests: remembers every event, in order. */
export function recordingEmitter(): Emitter & { events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  return {
    events,
    emit(name, payload) {
      events.push({ name, payload });
    },
  };
}
