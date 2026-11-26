import { randomBytes } from "node:crypto";
import {
  createAcepMessage,
  type AcepMessage,
  type TrustMode,
} from "../protocol/types.js";
import { RelayServer } from "../relay/server.js";
import {
  startCloudflaredTunnel,
  type PublicTunnelHandle,
} from "../relay/cloudflared.js";
import { TunnelClient } from "../client/tunnel-client.js";
import {
  DEFAULT_NOSTR_RELAYS,
  NostrTunnelClient,
} from "../client/nostr-client.js";
import type { TunnelTransport } from "../client/transport.js";
import { sanitizeForPublic } from "../security/sanitizer.js";

export type ChannelTransportMode = "relay" | "nostr";

export const DEFAULT_MAX_TURNS = 10;
export const DEFAULT_TTL_SEC = 600;

export type StartPublicTunnelFn = (
  localHttpUrl: string,
) => Promise<PublicTunnelHandle>;

export interface TunnelToolManagerOptions {
  startPublicTunnel?: StartPublicTunnelFn;
}

interface ManagedChannel {
  channel_id: string;
  role: "host" | "seeker";
  trust_mode: TrustMode;
  purpose: string;
  client: TunnelTransport;
  max_turns: number | null;
  turns_used: number;
  expires_at: number | null;
  ttl_timer: ReturnType<typeof setTimeout> | null;
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
  private publicTunnel: PublicTunnelHandle | null = null;
  private publicTunnelPromise: Promise<PublicTunnelHandle> | null = null;
  private readonly startPublicTunnel: StartPublicTunnelFn;
  private channels = new Map<string, ManagedChannel>();

  constructor(options: TunnelToolManagerOptions = {}) {
    this.startPublicTunnel =
      options.startPublicTunnel ?? startCloudflaredTunnel;
  }

  private async ensurePublicTunnel(
    localWsUrl: string,
  ): Promise<PublicTunnelHandle> {
    if (this.publicTunnel) {
      return this.publicTunnel;
    }
    if (!this.publicTunnelPromise) {
      const httpUrl = localWsUrl.replace(/^ws:/, "http:");
      this.publicTunnelPromise = this.startPublicTunnel(httpUrl)
        .then((handle) => {
          this.publicTunnel = handle;
          return handle;
        })
        .catch((err) => {
          this.publicTunnel = null;
          this.publicTunnelPromise = null;
          throw err;
        });
    }
    return this.publicTunnelPromise;
  }

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
    if (ch.expires_at !== null && Date.now() >= ch.expires_at) {
      void this.closeChannel(channelId);
      throw new Error(`Channel expired (TTL exceeded): ${channelId}`);
    }
    return ch;
  }

  private async closeChannel(channelId: string): Promise<void> {
    const ch = this.channels.get(channelId);
    if (!ch) return;
    if (ch.ttl_timer) {
      clearTimeout(ch.ttl_timer);
      ch.ttl_timer = null;
    }
    this.channels.delete(channelId);
    await ch.client.close();
  }

  private registerHostChannel(params: {
    channelId: string;
    trustMode: TrustMode;
    purpose: string;
    client: TunnelTransport;
    maxTurns: number;
    ttlSec: number;
  }): string {
    const expiresAtMs = Date.now() + params.ttlSec * 1000;
    const ttlTimer = setTimeout(() => {
      void this.closeChannel(params.channelId);
    }, params.ttlSec * 1000);
    ttlTimer.unref?.();

    this.channels.set(params.channelId, {
      channel_id: params.channelId,
      role: "host",
      trust_mode: params.trustMode,
      purpose: params.purpose,
      client: params.client,
      max_turns: params.maxTurns,
      turns_used: 0,
      expires_at: expiresAtMs,
      ttl_timer: ttlTimer,
    });

    return new Date(expiresAtMs).toISOString();
  }

  private async awaitPeerMessage(
    client: TunnelTransport,
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
    expose_public?: boolean;
    transport?: ChannelTransportMode;
    nostr_relays?: string[];
    max_turns?: number;
    ttl_sec?: number;
  }): Promise<{
    channel_id: string;
    join_token: string;
    connect_uri: string;
    max_turns: number;
    ttl_sec: number;
    expires_at: string;
  }> {
    const maxTurns = args.max_turns ?? DEFAULT_MAX_TURNS;
    const ttlSec = args.ttl_sec ?? DEFAULT_TTL_SEC;
    if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
      throw new Error(`Invalid max_turns "${maxTurns}": expected a positive integer`);
    }
    if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
      throw new Error(`Invalid ttl_sec "${ttlSec}": expected a positive number`);
    }

    const transportMode: ChannelTransportMode = args.transport ?? "relay";
    if (transportMode === "nostr") {
      if (args.relay_url || args.expose_public) {
        throw new Error(
          "Cannot combine transport=\"nostr\" with relay_url or expose_public",
        );
      }
      const rawRelays =
        args.nostr_relays && args.nostr_relays.length > 0
          ? args.nostr_relays
          : DEFAULT_NOSTR_RELAYS;
      const relays = rawRelays.map((r) => this.normalizeRelayUrl(r).relayUrl);
      const channelId = `ch_${randomBytes(6).toString("hex")}`;
      const joinToken = `tok_${randomBytes(12).toString("hex")}`;
      const purpose =
        args.trust_mode === "public"
          ? sanitizeForPublic(args.purpose).sanitized
          : args.purpose;

      const nostrClient = new NostrTunnelClient();
      await nostrClient.connect({
        relays,
        role: "host",
        channelId,
        joinToken,
      });

      const expiresAt = this.registerHostChannel({
        channelId,
        trustMode: args.trust_mode,
        purpose,
        client: nostrClient,
        maxTurns,
        ttlSec,
      });

      const relayParams = relays
        .map((r) => `relay=${encodeURIComponent(r)}`)
        .join("&");
      const connectUri = `acep+nostr://${nostrClient.pubkey}/${channelId}?token=${joinToken}&trust=${args.trust_mode}&purpose=${encodeURIComponent(purpose)}&${relayParams}`;

      return {
        channel_id: channelId,
        join_token: joinToken,
        connect_uri: connectUri,
        max_turns: maxTurns,
        ttl_sec: ttlSec,
        expires_at: expiresAt,
      };
    }

    if (args.relay_url && args.expose_public) {
      throw new Error(
        "Cannot specify both relay_url and expose_public=true",
      );
    }
    const rawRelayUrl = args.relay_url ?? (await this.ensureLocalRelay());
    const { relayUrl, parsed: parsedRelay } = this.normalizeRelayUrl(rawRelayUrl);
    let publicParsedRelay = parsedRelay;
    if (!args.relay_url && args.expose_public) {
      const tunnel = await this.ensurePublicTunnel(relayUrl);
      const normalizedPublic = this.normalizeRelayUrl(tunnel.publicUrl);
      publicParsedRelay = normalizedPublic.parsed;
    }
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

    const expiresAt = this.registerHostChannel({
      channelId,
      trustMode: args.trust_mode,
      purpose,
      client,
      maxTurns,
      ttlSec,
    });

    const scheme = publicParsedRelay.protocol === "wss:" ? "aceps" : "acep";
    const connectUri = `${scheme}://${publicParsedRelay.host}/${channelId}?token=${joinToken}&trust=${args.trust_mode}&purpose=${encodeURIComponent(purpose)}`;

    return {
      channel_id: channelId,
      join_token: joinToken,
      connect_uri: connectUri,
      max_turns: maxTurns,
      ttl_sec: ttlSec,
      expires_at: expiresAt,
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
  }): Promise<{
    sent: boolean;
    message_id: string;
    warnings: string[];
    turns_remaining: number | null;
    closed_by_limit: boolean;
  }> {
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

    await ch.client.send(msg);

    if (args.type === "CLOSE") {
      await this.closeChannel(ch.channel_id);
      return {
        sent: true,
        message_id: msg.message_id,
        warnings,
        turns_remaining:
          ch.max_turns !== null ? Math.max(0, ch.max_turns - ch.turns_used) : null,
        closed_by_limit: false,
      };
    }

    ch.turns_used += 1;
    const turnsRemaining =
      ch.max_turns !== null ? Math.max(0, ch.max_turns - ch.turns_used) : null;
    const reachedLimit = ch.max_turns !== null && ch.turns_used >= ch.max_turns;
    if (reachedLimit) {
      await this.closeChannel(ch.channel_id);
    }

    return {
      sent: true,
      message_id: msg.message_id,
      warnings,
      turns_remaining: turnsRemaining,
      closed_by_limit: reachedLimit,
    };
  }

  /**
   * Connects as a seeker to an existing channel using an `acep://`, `aceps://`,
   * or `acep+nostr://` URI and sends the initial `HANDSHAKE` message.
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
    if (
      uri.protocol !== "acep:" &&
      uri.protocol !== "aceps:" &&
      uri.protocol !== "acep+nostr:"
    ) {
      throw new Error(
        `Invalid connect_uri protocol "${uri.protocol}": expected "acep:", "aceps:", or "acep+nostr:"`,
      );
    }

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
      await this.closeChannel(channelId);
    }

    let client: TunnelTransport;
    if (uri.protocol === "acep+nostr:") {
      const hostPubkey = uri.hostname;
      const rawRelays = uri.searchParams.getAll("relay");
      if (!hostPubkey || rawRelays.length === 0) {
        throw new Error(
          "Invalid acep+nostr URI: missing host pubkey or relay parameter",
        );
      }
      const relays = rawRelays.map((r) => this.normalizeRelayUrl(r).relayUrl);
      const nostrClient = new NostrTunnelClient();
      await nostrClient.connect({
        relays,
        role: "seeker",
        channelId,
        joinToken: token,
        peerPubkey: hostPubkey,
      });
      client = nostrClient;
    } else {
      const wsProtocol = uri.protocol === "aceps:" ? "wss:" : "ws:";
      const relayUrl = `${wsProtocol}//${uri.host}`;
      const wsClient = new TunnelClient();
      await wsClient.connect({
        relayUrl,
        channelId,
        token,
        role: "seeker",
      });
      client = wsClient;
    }

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
      await client.send(handshake);
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
      max_turns: null,
      turns_used: 0,
      expires_at: null,
      ttl_timer: null,
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
    await ch.client.send(msg);

    if (args.type === "CLOSE") {
      return { status: "message", message: msg };
    }

    return this.awaitPeerMessage(ch.client, args.timeout_sec ?? 60);
  }

  /**
   * Closes all managed channel clients and stops the local relay server if running.
   */
  async dispose(): Promise<void> {
    for (const channelId of Array.from(this.channels.keys())) {
      await this.closeChannel(channelId);
    }
    if (this.publicTunnel) {
      await this.publicTunnel.stop();
      this.publicTunnel = null;
    }
    this.publicTunnelPromise = null;
    if (this.localRelay) {
      await this.localRelay.stop();
      this.localRelay = null;
      this.localRelayUrl = null;
    }
    this.localRelayPromise = null;
  }
}
