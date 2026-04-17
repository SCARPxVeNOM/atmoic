/**
 * Composer SDK — third-party integration layer.
 *
 * Per composable-perps-docs Phase 4: other protocols build on top
 * of the atomic composer. Versioned API with rate limiting.
 */

export interface ComposerClient {
  apiKey: string;
  name: string;
  rateLimit: number; // requests per minute
  createdAt: number;
  requestCount: number;
  lastRequestAt: number;
}

export interface ComposerEvent {
  type: "position_opened" | "position_closed" | "liquidation" | "batch_cleared";
  data: Record<string, any>;
  timestamp: number;
}

const clients: Map<string, ComposerClient> = new Map();
const eventListeners: Map<string, ((event: ComposerEvent) => void)[]> = new Map();

/** Register a new API client. */
export function registerClient(apiKey: string, name: string, rateLimit = 60): void {
  clients.set(apiKey, {
    apiKey,
    name,
    rateLimit,
    createdAt: Date.now(),
    requestCount: 0,
    lastRequestAt: 0,
  });
}

/** Validate an API key and check rate limit. */
export function validateRequest(apiKey: string): { valid: boolean; error?: string } {
  const client = clients.get(apiKey);
  if (!client) return { valid: false, error: "Invalid API key" };

  const now = Date.now();
  const windowMs = 60_000;

  // Reset counter if window passed
  if (now - client.lastRequestAt > windowMs) {
    client.requestCount = 0;
  }

  if (client.requestCount >= client.rateLimit) {
    return { valid: false, error: "Rate limit exceeded" };
  }

  client.requestCount++;
  client.lastRequestAt = now;
  return { valid: true };
}

/** Subscribe to protocol events. */
export function subscribe(
  eventType: string,
  callback: (event: ComposerEvent) => void,
): void {
  if (!eventListeners.has(eventType)) eventListeners.set(eventType, []);
  eventListeners.get(eventType)!.push(callback);
}

/** Emit a protocol event to all subscribers. */
export function emitEvent(event: ComposerEvent): void {
  const listeners = eventListeners.get(event.type) ?? [];
  for (const cb of listeners) {
    try { cb(event); } catch { /* subscriber error */ }
  }
  // Also emit to wildcard listeners
  const wildcardListeners = eventListeners.get("*") ?? [];
  for (const cb of wildcardListeners) {
    try { cb(event); } catch { /* subscriber error */ }
  }
}
