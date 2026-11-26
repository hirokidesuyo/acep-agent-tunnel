import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { generateSecretKey } from "nostr-tools/pure";
import {
  ACEP_NOSTR_KIND,
  NIP44_MAX_PLAINTEXT_BYTES,
  NostrTunnelClient,
  ProxiedWebSocket,
} from "../src/client/nostr-client.js";
import { createAcepMessage } from "../src/protocol/types.js";
import { TunnelToolManager } from "../src/mcp/tools.js";

interface StoredSub {
  ws: WebSocket;
  subId: string;
  pTags: string[];
}

function startMockNostrRelay(): Promise<{
  url: string;
  observedEvents: Array<{ kind: number; content: string; pubkey: string }>;
  stop: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const subs: StoredSub[] = [];
    const observedEvents: Array<{
      kind: number;
      content: string;
      pubkey: string;
    }> = [];

    wss.once("error", reject);
    wss.once("listening", () => {
      const addr = wss.address() as AddressInfo;
      resolve({
        url: `ws://127.0.0.1:${addr.port}`,
        observedEvents,
        stop: () =>
          new Promise<void>((res) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => res());
          }),
      });
    });

    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString("utf8"));
        } catch {
          return;
        }
        if (!Array.isArray(msg)) return;
        const [verb, ...rest] = msg;

        if (verb === "REQ" && typeof rest[0] === "string") {
          const subId = rest[0];
          const filter = (rest[1] ?? {}) as { "#p"?: string[] };
          subs.push({ ws, subId, pTags: filter["#p"] ?? [] });
          ws.send(JSON.stringify(["EOSE", subId]));
        } else if (verb === "CLOSE" && typeof rest[0] === "string") {
          const subId = rest[0];
          for (let i = subs.length - 1; i >= 0; i--) {
            if (subs[i].ws === ws && subs[i].subId === subId) {
              subs.splice(i, 1);
            }
          }
        } else if (verb === "EVENT" && rest[0] && typeof rest[0] === "object") {
          const ev = rest[0] as {
            id: string;
            kind: number;
            content: string;
            pubkey: string;
            tags: string[][];
          };
          observedEvents.push({
            kind: ev.kind,
            content: ev.content,
            pubkey: ev.pubkey,
          });
          ws.send(JSON.stringify(["OK", ev.id, true, ""]));

          const evPTags = ev.tags
            .filter((t) => t[0] === "p" && typeof t[1] === "string")
            .map((t) => t[1]);

          for (const sub of subs) {
            if (sub.ws.readyState !== WebSocket.OPEN) continue;
            if (
              sub.pTags.length === 0 ||
              evPTags.some((p) => sub.pTags.includes(p))
            ) {
              sub.ws.send(JSON.stringify(["EVENT", sub.subId, ev]));
            }
          }
        }
      });
    });
  });
}

describe("NostrTunnelClient & acep+nostr:// MCP flow", () => {
  let relayStop: (() => Promise<void>) | null = null;
  const hostManager = new TunnelToolManager();
  const seekerManager = new TunnelToolManager();

  afterEach(async () => {
    await seekerManager.dispose();
    await hostManager.dispose();
    if (relayStop) {
      await relayStop();
      relayStop = null;
    }
  });

  it("encrypts payloads with NIP-44 ephemeral events and rejects wrong join_token", async () => {
    const relay = await startMockNostrRelay();
    relayStop = relay.stop;

    const host = new NostrTunnelClient();
    const intruder = new NostrTunnelClient();
    const seeker = new NostrTunnelClient();

    await host.connect({
      relays: [relay.url],
      role: "host",
      channelId: "ch_nostr_1",
      joinToken: "tok_valid_123",
    });

    await intruder.connect({
      relays: [relay.url],
      role: "seeker",
      channelId: "ch_nostr_1",
      joinToken: "tok_wrong_999",
      peerPubkey: host.pubkey,
      secretKey: generateSecretKey(),
    });

    await intruder.send(
      createAcepMessage({
        channel_id: "ch_nostr_1",
        sender_role: "seeker",
        type: "HANDSHAKE",
        payload: { purpose: "spoof" },
      }),
    );

    const dropped = await host.waitForMessage(150);
    expect(dropped).toBeNull();

    await seeker.connect({
      relays: [relay.url],
      role: "seeker",
      channelId: "ch_nostr_1",
      joinToken: "tok_valid_123",
      peerPubkey: host.pubkey,
    });

    await seeker.send(
      createAcepMessage({
        channel_id: "ch_nostr_1",
        sender_role: "seeker",
        type: "HANDSHAKE",
        payload: { purpose: "legit" },
      }),
    );

    const handshake = await host.waitForMessage(2000);
    expect(handshake?.type).toBe("HANDSHAKE");

    await seeker.send(
      createAcepMessage({
        channel_id: "ch_nostr_1",
        sender_role: "seeker",
        type: "QUERY",
        payload: { question: "Secret question" },
      }),
    );

    const query = await host.waitForMessage(2000);
    expect(query?.payload.question).toBe("Secret question");

    // Relay never sees plaintext
    expect(relay.observedEvents.every((e) => e.kind === ACEP_NOSTR_KIND)).toBe(
      true,
    );
    expect(
      relay.observedEvents.some((e) => e.content.includes("Secret question")),
    ).toBe(false);

    await host.close();
    await intruder.close();
    await seeker.close();
  });

  it("completes full open_channel -> connect_channel -> QUERY -> ANSWER flow over acep+nostr://", async () => {
    const relay = await startMockNostrRelay();
    relayStop = relay.stop;

    const opened = await hostManager.openChannel({
      purpose: "VM to agy via Nostr",
      trust_mode: "public",
      context_summary: "Gemma 100 tok/s",
      transport: "nostr",
      nostr_relays: [relay.url],
    });

    expect(opened.connect_uri).toMatch(/^acep\+nostr:\/\//);

    const hostWaitHandshake = hostManager.waitForPeer({
      channel_id: opened.channel_id,
      timeout_sec: 5,
    });

    const connected = await seekerManager.connectChannel({
      connect_uri: opened.connect_uri,
    });
    expect(connected.channel_id).toBe(opened.channel_id);

    const hs = await hostWaitHandshake;
    expect(hs.status).toBe("message");
    expect(hs.message?.type).toBe("HANDSHAKE");

    const hostWaitQuery = hostManager.waitForPeer({
      channel_id: opened.channel_id,
      timeout_sec: 5,
    });

    const seekerAsk = seekerManager.askPeer({
      channel_id: connected.channel_id,
      type: "QUERY",
      question: "Why 50 tok/s?",
      context_slots: { gpu: "RTX4090" },
      requested_slots: ["launch_args"],
      timeout_sec: 5,
    });

    const queryMsg = await hostWaitQuery;
    expect(queryMsg.message?.type).toBe("QUERY");

    await hostManager.replyToPeer({
      channel_id: opened.channel_id,
      reply_to: queryMsg.message!.message_id,
      type: "ANSWER",
      content: {
        summary: "Use --flash-attn (path /Users/alice/llama/run.sh)",
        provided_slots: { launch_args: "--flash-attn" },
      },
    });

    const answerRes = await seekerAsk;
    expect(answerRes.message?.type).toBe("ANSWER");
    expect(answerRes.message?.payload.summary).toBe(
      "Use --flash-attn (path ~/llama/run.sh)",
    );
  });

  it("attaches a no-op error listener on ProxiedWebSocket so closing before open does not crash", async () => {
    const relay = await startMockNostrRelay();
    relayStop = relay.stop;

    const ws = new ProxiedWebSocket(relay.url);
    expect(ws.listenerCount("error")).toBeGreaterThanOrEqual(1);
    // Closing immediately before open triggers ws 'error' event; must not throw unhandled error
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  });

  it("throws a clear error when serialized payload exceeds NIP-44 64KB limit", async () => {
    const relay = await startMockNostrRelay();
    relayStop = relay.stop;

    const host = new NostrTunnelClient();
    const seeker = new NostrTunnelClient();

    await host.connect({
      relays: [relay.url],
      role: "host",
      channelId: "ch_size",
      joinToken: "tok_size",
    });

    await seeker.connect({
      relays: [relay.url],
      role: "seeker",
      channelId: "ch_size",
      joinToken: "tok_size",
      peerPubkey: host.pubkey,
    });

    const huge = "x".repeat(NIP44_MAX_PLAINTEXT_BYTES + 100);
    await expect(
      seeker.send(
        createAcepMessage({
          channel_id: "ch_size",
          sender_role: "seeker",
          type: "QUERY",
          payload: { question: huge },
        }),
      ),
    ).rejects.toThrow(/exceeds NIP-44 maximum plaintext limit/i);

    await host.close();
    await seeker.close();
  });
});
