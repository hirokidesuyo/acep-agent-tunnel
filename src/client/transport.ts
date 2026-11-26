import type { AcepMessage } from "../protocol/types.js";

/**
 * Common transport interface shared by WebSocket relay and Nostr relay clients.
 */
export interface TunnelTransport {
  send(msg: AcepMessage): void | Promise<void>;
  waitForMessage(timeoutMs?: number): Promise<AcepMessage | null>;
  close(): Promise<void>;
}
