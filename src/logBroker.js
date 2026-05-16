// In-memory live event log for the dashboard.
// Ring buffer of the last MAX events + EventEmitter for SSE subscribers.

import { EventEmitter } from 'node:events';

const MAX = 200;
const buffer = [];
const emitter = new EventEmitter();
emitter.setMaxListeners(100); // generous; one listener per open browser tab

/**
 * Record an event and broadcast to all subscribers.
 * Returns the full event object (with ts).
 */
export function logEvent({ level = 'info', source = 'system', message, ...data }) {
  const event = {
    ts: Date.now(),
    level,
    source,
    message,
    ...data,
  };
  buffer.push(event);
  if (buffer.length > MAX) buffer.shift();
  emitter.emit('event', event);
  return event;
}

export function getRecent() {
  return buffer.slice();
}

export function subscribe(handler) {
  emitter.on('event', handler);
  return () => emitter.off('event', handler);
}
