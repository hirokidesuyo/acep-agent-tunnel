import { WebSocket, type ClientOptions } from "ws";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event as NostrEvent,
} from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import {
  AcepMessageSchema,
  type AcepMessage,
  type SenderRole,
} from "../protocol/types.js";
import { createProxyAgent, resolveProxyUrl } from "./proxy-agent.js";
import type { TunnelTransport } from "./transport.js";

export const ACEP_NOSTR_KIND = 21337;

export const DEFAULT_NOSTR_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
];

class ProxiedWebSocket extends WebSocket {
  constructor(
    address: string | URL,
    protocols?: string | string[] | ClientOptions,
    options?: ClientOptions,
  ) {
    const urlStr = address.toString();
    const proxyUrl = resolveProxyUrl(urlStr);
    if (!proxyUrl) {
      if (options !== undefined) {
        super(address, protocols as string | string[], options);
      } else if (protocols !== undefined) {
        super(address, protocols as string | string[]);
      } else {
        super(address);
      }
      return;
    }

    const agent = createProxyAgent(urlStr, proxyUrl);
    if (typeof protocols === "object" && !Array.isArray(protocols)) {
      super(address, { ...protocols, agent });
    } else if (options !== undefined) {
      super(address, protocols, { ...options, agent });
    } else if (protocols !== undefined) {
      super(address, protocols, { agent });
    } else {
      super(address, { agent });
    }
  }
}

useWebSocketImplementation(ProxiedWebSocket);

interface SubCloser {
  close: (reason?: string) => void;
}

/**
 * ACEP transport over Nostr relays using ephemeral NIP-44 encrypted events
 * (kind 21337) and per-session disposable keypairs.
 */
export class NostrTunnelClient implements TunnelTransport {
  private pool: SimplePool | null = null;
  private sub: SubCloser | null = null;
  private relays: string[] = [];
  private secretKey: Uint8Array = generateSecretKey();
  public pubkey = "";
  private peerPubkey: string | null = null;
  private role: SenderRole = "host";
  private joinToken = "";
  private closed = false;

  private queue: AcepMessage[] = [];
  private waiters: Array<(msg: AcepMessage | null) => void> = [];
  private seenMessageIds = new Set<string>();

  async connect(params: {
    relays: string[];
    role: SenderRole;
    channelId: string;
    joinToken: string;
    secretKey?: Uint8Array;
    peerPubkey?: string;
    subscribeTimeoutMs?: number;
  }): Promise<void> {
    if (params.relays.length === 0) {
      throw new Error("At least one Nostr relay URL is required");
    }
    this.relays = params.relays;
    this.role = params.role;
    this.joinToken = params.joinToken;
    this.secretKey = params.secretKey ?? generateSecretKey();
    this.pubkey = getPublicKey(this.secretKey);
    this.peerPubkey = params.peerPubkey ?? null;
    this.closed = false;

    const pool = new SimplePool();
    this.pool = pool;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(done, params.subscribeTimeoutMs ?? 1500);

      this.sub = pool.subscribe(
        this.relays,
        {
          kinds: [ACEP_NOSTR_KIND],
          "#p": [this.pubkey],
        },
        {
          onevent: (event) => {
            this.handleIncomingEvent(event);
          },
          oneose: () => {
            done();
          },
        },
      );
    });
  }

  private handleIncomingEvent(event: NostrEvent): void {
    if (this.closed) return;
    if (event.kind !== ACEP_NOSTR_KIND) return;
    if (!verifyEvent(event)) return;

    if (this.peerPubkey && event.pubkey !== this.peerPubkey) {
      // Drop messages from unauthorized senders once peer is locked
      return;
    }

    let decrypted: string;
    try {
      const convKey = nip44.getConversationKey(this.secretKey, event.pubkey);
      decrypted = nip44.decrypt(event.content, convKey);
    } catch {
      return;
    }

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(decrypted);
    } catch {
      return;
    }

    const parsed = AcepMessageSchema.safeParse(rawJson);
    if (!parsed.success) return;
    const msg = parsed.data;

    if (this.role === "host" && !this.peerPubkey) {
      if (msg.type !== "HANDSHAKE") return;
      if (msg.payload.join_token !== this.joinToken) {
        return;
      }
      this.peerPubkey = event.pubkey;
    }

    if (this.seenMessageIds.has(msg.message_id)) {
      return;
    }
    this.seenMessageIds.add(msg.message_id);

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  async send(msg: AcepMessage): Promise<void> {
    if (this.closed || !this.pool) {
      throw new Error("NostrTunnelClient is not connected");
    }
    if (!this.peerPubkey) {
      throw new Error("Cannot send message before peer public key is known");
    }

    const outgoing: AcepMessage =
      this.role === "seeker" && msg.type === "HANDSHAKE"
        ? {
            ...msg,
            payload: {
              ...msg.payload,
              join_token: this.joinToken,
            },
          }
        : msg;

    const convKey = nip44.getConversationKey(this.secretKey, this.peerPubkey);
    const ciphertext = nip44.encrypt(JSON.stringify(outgoing), convKey);

    const signedEvent = finalizeEvent(
      {
        kind: ACEP_NOSTR_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", this.peerPubkey]],
        content: ciphertext,
      },
      this.secretKey,
    );

    const results = this.pool.publish(this.relays, signedEvent);
    await Promise.any(results);
  }

  async waitForMessage(timeoutMs = 120_000): Promise<AcepMessage | null> {
    if (this.queue.length > 0) {
      return this.queue.shift() ?? null;
    }
    if (this.closed || !this.pool) {
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
    if (this.closed) return;
    this.closed = true;
    this.flushWaitersWithNull();
    if (this.sub) {
      try {
        this.sub.close();
      } catch {
        // Ignore close errors
      }
      this.sub = null;
    }
    if (this.pool) {
      try {
        this.pool.close(this.relays);
      } catch {
        // Ignore pool close errors
      }
      this.pool = null;
    }
  }
}
