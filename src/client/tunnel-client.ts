import { WebSocket } from "ws";
import { AcepMessageSchema, type AcepMessage, type SenderRole } from "../protocol/types.js";
import { createProxyAgent, resolveProxyUrl } from "./proxy-agent.js";

export class TunnelClient {
  private ws: WebSocket | null = null;
  private queue: AcepMessage[] = [];
  private waiters: Array<(msg: AcepMessage | null) => void> = [];

  async connect(params: {
    relayUrl: string;
    channelId: string;
    token: string;
    role: SenderRole;
    proxyUrl?: string | null;
  }): Promise<void> {
    const base = params.relayUrl.replace(/\/$/, "");
    const wsUrl = `${base}/?channel_id=${encodeURIComponent(params.channelId)}&token=${encodeURIComponent(params.token)}&role=${params.role}`;

    const proxyUrl =
      params.proxyUrl !== undefined ? params.proxyUrl : resolveProxyUrl(wsUrl);
    const agent = proxyUrl ? createProxyAgent(wsUrl, proxyUrl) : undefined;

    return new Promise((resolve, reject) => {
      const ws = agent ? new WebSocket(wsUrl, { agent }) : new WebSocket(wsUrl);
      let settled = false;

      ws.once("open", () => {
        settled = true;
        this.ws = ws;
        resolve();
      });

      ws.once("close", (code, reason) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Connection rejected (${code}): ${reason.toString()}`));
        }
        if (this.ws === ws) {
          this.ws = null;
        }
        this.flushWaitersWithNull();
      });

      ws.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ws.on("message", (raw) => {
        try {
          const parsed = AcepMessageSchema.parse(JSON.parse(raw.toString("utf8")));
          const waiter = this.waiters.shift();
          if (waiter) {
            waiter(parsed);
          } else {
            this.queue.push(parsed);
          }
        } catch {
          // Ignore malformed payloads
        }
      });
    });
  }

  send(msg: AcepMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("TunnelClient is not connected");
    }
    this.ws.send(JSON.stringify(msg));
  }

  async waitForMessage(timeoutMs = 120_000): Promise<AcepMessage | null> {
    if (this.queue.length > 0) {
      return this.queue.shift() ?? null;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return null;
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(onMessage);
        if (idx !== -1) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      const onMessage = (msg: AcepMessage | null) => {
        clearTimeout(timer);
        resolve(msg);
      };

      this.waiters.push(onMessage);
    });
  }

  private flushWaitersWithNull(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.(null);
    }
  }

  async close(): Promise<void> {
    this.flushWaitersWithNull();
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    if (ws.readyState === WebSocket.CLOSED) return;
    return new Promise((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
  }
}
