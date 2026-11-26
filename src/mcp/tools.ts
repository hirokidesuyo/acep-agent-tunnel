import { randomBytes } from "node:crypto";
import {
  createAcepMessage,
  type AcepMessage,
  type TrustMode,
} from "../protocol/types.js";
import { RelayServer } from "../relay/server.js";
import { TunnelClient } from "../client/tunnel-client.js";
import { sanitizeForPublic } from "../security/sanitizer.js";

interface ManagedChannel {
  channel_id: string;
  role: "host" | "seeker";
  trust_mode: TrustMode;
  purpose: string;
  client: TunnelClient;
}

export interface WaitResult {
  status: "message" | "timeout";
  message: AcepMessage | null;
}

/**
 * Manages ACEP channels, local relay lifecycle, and public-mode sanitization
 * for the five MCP tunnel tools.
 */
export class TunnelToolManager {
  private localRelay: RelayServer | null = null;
  private localRelayUrl: string | null = null;
  private localRelayPromise: Promise<string> | null = null;
  private channels = new Map<string, ManagedChannel>();

  private async ensureLocalRelay(): Promise<string> {
    if (this.localRelayUrl) {
      return this.localRelayUrl;
    }
    if (!this.localRelayPromise) {
      const relay = new RelayServer();
      this.localRelayPromise = relay
        .start(0)
        .then((started) => {
          this.localRelay = relay;
          this.localRelayUrl = started.url;
          return started.url;
        })
        .catch((err) => {
          this.localRelay = null;
          this.localRelayUrl = null;
          this.localRelayPromise = null;
          throw err;
        });
    }
    return this.localRelayPromise;
  }

  private normalizeRelayUrl(rawUrl: string): { relayUrl: string; parsed: URL } {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`Invalid relay_url: ${rawUrl}`);
    }
    if (parsed.protocol === "http:") {
      parsed.protocol = "ws:";
    } else if (parsed.protocol === "https:") {
      parsed.protocol = "wss:";
    } else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new Error(
        `Invalid relay_url protocol "${parsed.protocol}": expected ws:, wss:, http:, or https:`,
      );
    }
    return {
      relayUrl: parsed.toString().replace(/\/$/, ""),
      parsed,
    };
  }

  private getChannel(channelId: string): ManagedChannel {
    const ch = this.channels.get(channelId);
    if (!ch) {
      throw new Error(`Unknown channel: ${channelId}`);
    }
    return ch;
  }

  private async awaitPeerMessage(
    client: TunnelClient,
    timeoutSec: number,
  ): Promise<WaitResult> {
    const msg = await client.waitForMessage(timeoutSec * 1000);
    if (!msg) {
      return { status: "timeout", message: null };
    }
    return { status: "message", message: msg };
  }

  /**
   * Opens a new host channel on the local or specified relay and returns
   * its connection URI.
   */
  async openChannel(args: {
    purpose: string;
    trust_mode: TrustMode;
    context_summary: string;
    relay_url?: string;
  }): Promise<{ channel_id: string; join_token: string; connect_uri: string }> {
    const rawRelayUrl = args.relay_url ?? (await this.ensureLocalRelay());
    const { relayUrl, parsed: parsedRelay } = this.normalizeRelayUrl(rawRelayUrl);
    const channelId = `ch_${randomBytes(6).toString("hex")}`;
    const joinToken = `tok_${randomBytes(12).toString("hex")}`;
    const purpose =
      args.trust_mode === "public"
        ? sanitizeForPublic(args.purpose).sanitized
        : args.purpose;

    const client = new TunnelClient();
    await client.connect({
      relayUrl,
      channelId,
      token: joinToken,
      role: "host",
    });

    this.channels.set(channelId, {
      channel_id: channelId,
      role: "host",
      trust_mode: args.trust_mode,
      purpose,
      client,
    });

    const scheme = parsedRelay.protocol === "wss:" ? "aceps" : "acep";
    const connectUri = `${scheme}://${parsedRelay.host}/${channelId}?token=${joinToken}&trust=${args.trust_mode}&purpose=${encodeURIComponent(purpose)}`;

    return {
      channel_id: channelId,
      join_token: joinToken,
      connect_uri: connectUri,
    };
  }

  /**
   * Waits for the next incoming ACEP message on the given channel.
   */
  async waitForPeer(args: {
    channel_id: string;
    timeout_sec?: number;
  }): Promise<WaitResult> {
    const ch = this.getChannel(args.channel_id);
    return this.awaitPeerMessage(ch.client, args.timeout_sec ?? 120);
  }

  /**
   * Sends a reply (`NEED_INFO`, `ANSWER`, or `CLOSE`) to the peer,
   * sanitizing the payload when the channel is in `public` trust mode.
   */
  async replyToPeer(args: {
    channel_id: string;
    reply_to: string;
    type: "NEED_INFO" | "ANSWER" | "CLOSE";
    content: Record<string, unknown>;
  }): Promise<{ sent: boolean; message_id: string; warnings: string[] }> {
    const ch = this.getChannel(args.channel_id);

    let payload = args.content;
    let warnings: string[] = [];

    if (ch.trust_mode === "public") {
      const res = sanitizeForPublic(args.content);
      payload = res.sanitized;
      warnings = res.warnings;
    }

    const msg = createAcepMessage({
      channel_id: ch.channel_id,
      sender_role: ch.role,
      type: args.type,
      reply_to: args.reply_to,
      payload,
    });

    ch.client.send(msg);
    return { sent: true, message_id: msg.message_id, warnings };
  }

  /**
   * Connects as a seeker to an existing channel using an `acep://` or `aceps://` URI
   * and sends the initial `HANDSHAKE` message.
   */
  async connectChannel(args: {
    connect_uri: string;
  }): Promise<{ channel_id: string; host_purpose: string; trust_mode: TrustMode }> {
    let uri: URL;
    try {
      uri = new URL(args.connect_uri);
    } catch {
      throw new Error(`Invalid connect_uri: ${args.connect_uri}`);
    }
    if (uri.protocol !== "acep:" && uri.protocol !== "aceps:") {
      throw new Error(
        `Invalid connect_uri protocol "${uri.protocol}": expected "acep:" or "aceps:"`,
      );
    }

    const wsProtocol = uri.protocol === "aceps:" ? "wss:" : "ws:";
    const relayUrl = `${wsProtocol}//${uri.host}`;
    const channelId = uri.pathname.replace(/^\//, "");
    const token = uri.searchParams.get("token");
    const rawTrust = uri.searchParams.get("trust");
    const trustMode: TrustMode = rawTrust === "trusted" ? "trusted" : "public";
    const purpose = uri.searchParams.get("purpose") ?? "General consultation";

    if (!channelId || !token) {
      throw new Error("Invalid connect_uri: missing channel_id or token");
    }

    const previous = this.channels.get(channelId);
    if (previous) {
      await previous.client.close();
      this.channels.delete(channelId);
    }

    const client = new TunnelClient();
    await client.connect({
      relayUrl,
      channelId,
      token,
      role: "seeker",
    });

    const handshake = createAcepMessage({
      channel_id: channelId,
      sender_role: "seeker",
      type: "HANDSHAKE",
      payload: {
        purpose,
        trust_mode: trustMode,
        capabilities: ["acep/1.0"],
      },
    });
    try {
      client.send(handshake);
    } catch (err) {
      await client.close();
      throw err;
    }

    this.channels.set(channelId, {
      channel_id: channelId,
      role: "seeker",
      trust_mode: trustMode,
      purpose,
      client,
    });

    return {
      channel_id: channelId,
      host_purpose: purpose,
      trust_mode: trustMode,
    };
  }

  /**
   * Sends a `QUERY` or `CLOSE` message to the peer (sanitizing in `public` mode)
   * and, for `QUERY`, waits for the peer's response.
   */
  async askPeer(args: {
    channel_id: string;
    type: "QUERY" | "CLOSE";
    question?: string;
    context_slots?: Record<string, unknown>;
    requested_slots?: string[];
    timeout_sec?: number;
  }): Promise<WaitResult> {
    const ch = this.getChannel(args.channel_id);

    const rawPayload =
      args.type === "CLOSE"
        ? { reason: "resolved" }
        : {
            question: args.question ?? "",
            context_slots: args.context_slots ?? {},
            requested_slots: args.requested_slots ?? [],
          };

    const payload =
      ch.trust_mode === "public"
        ? sanitizeForPublic(rawPayload).sanitized
        : rawPayload;

    const msg = createAcepMessage({
      channel_id: ch.channel_id,
      sender_role: ch.role,
      type: args.type,
      payload,
    });
    ch.client.send(msg);

    if (args.type === "CLOSE") {
      return { status: "message", message: msg };
    }

    return this.awaitPeerMessage(ch.client, args.timeout_sec ?? 60);
  }

  /**
   * Closes all managed channel clients and stops the local relay server if running.
   */
  async dispose(): Promise<void> {
    for (const ch of this.channels.values()) {
      await ch.client.close();
    }
    this.channels.clear();
    if (this.localRelay) {
      await this.localRelay.stop();
      this.localRelay = null;
      this.localRelayUrl = null;
    }
    this.localRelayPromise = null;
  }
}
