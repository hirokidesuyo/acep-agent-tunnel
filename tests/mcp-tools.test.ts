import { describe, it, expect, afterEach, vi } from "vitest";
import { TunnelToolManager } from "../src/mcp/tools.js";
import { TunnelClient } from "../src/client/tunnel-client.js";

describe("TunnelToolManager (2-agent dialogue simulation)", () => {
  const hostManager = new TunnelToolManager();
  const seekerManager = new TunnelToolManager();

  afterEach(async () => {
    await seekerManager.dispose();
    await hostManager.dispose();
  });

  it("completes QUERY -> NEED_INFO -> QUERY -> ANSWER flow and sanitizes in public mode", async () => {
    const opened = await hostManager.openChannel({
      purpose: "Debug Gemma 50 tok/s vs 100 tok/s",
      trust_mode: "public",
      context_summary: "Achieved 100 tok/s with llama.cpp on RTX4090",
    });

    expect(opened.connect_uri).toMatch(/^acep:\/\//);

    // Host starts waiting for handshake + query
    const hostWaitPromise = hostManager.waitForPeer({
      channel_id: opened.channel_id,
      timeout_sec: 5,
    });

    // Seeker connects (automatically sends HANDSHAKE)
    const connected = await seekerManager.connectChannel({
      connect_uri: opened.connect_uri,
    });
    expect(connected.channel_id).toBe(opened.channel_id);

    const handshakeMsg = await hostWaitPromise;
    expect(handshakeMsg.status).toBe("message");
    expect(handshakeMsg.message?.type).toBe("HANDSHAKE");

    // Seeker asks first QUERY, Host waits and receives it
    const hostWaitQuery = hostManager.waitForPeer({
      channel_id: opened.channel_id,
      timeout_sec: 5,
    });

    const seekerAsk1 = seekerManager.askPeer({
      channel_id: connected.channel_id,
      type: "QUERY",
      question: "Why am I getting 50 tok/s? My key sk-seekerSecretKey1234567890",
      context_slots: { gpu: "RTX4090", backend: "llama.cpp", log_path: "/Users/bob/logs/run.log" },
      requested_slots: ["launch_args"],
      timeout_sec: 5,
    });

    const queryMsg1 = await hostWaitQuery;
    expect(queryMsg1.message?.type).toBe("QUERY");
    expect(queryMsg1.message?.payload.question).toContain("[REDACTED_SECRET]");
    expect((queryMsg1.message?.payload.context_slots as Record<string, string>).log_path).toBe(
      "~/logs/run.log",
    );

    // Host replies with NEED_INFO
    await hostManager.replyToPeer({
      channel_id: opened.channel_id,
      reply_to: queryMsg1.message!.message_id,
      type: "NEED_INFO",
      content: {
        reason: "Need flash_attention status",
        requested_slots: ["flash_attention"],
      },
    });

    const needInfoRes = await seekerAsk1;
    expect(needInfoRes.message?.type).toBe("NEED_INFO");

    // Seeker sends updated info, Host replies with ANSWER containing a secret that must be redacted
    const hostWaitQuery2 = hostManager.waitForPeer({
      channel_id: opened.channel_id,
      timeout_sec: 5,
    });

    const seekerAsk2 = seekerManager.askPeer({
      channel_id: connected.channel_id,
      type: "QUERY",
      question: "Here is my flash_attention status",
      context_slots: { flash_attention: false },
      requested_slots: ["launch_args"],
      timeout_sec: 5,
    });

    const queryMsg2 = await hostWaitQuery2;
    const replyRes = await hostManager.replyToPeer({
      channel_id: opened.channel_id,
      reply_to: queryMsg2.message!.message_id,
      type: "ANSWER",
      content: {
        summary: "Enable --flash-attn. My token sk-secretkey1234567890 shouldn't leak.",
        provided_slots: { config_path: "/Users/alice/llama/config.json" },
        verification_steps: ["Re-run benchmark"],
      },
    });

    expect(replyRes.warnings.length).toBeGreaterThan(0);

    const finalAnswer = await seekerAsk2;
    expect(finalAnswer.message?.type).toBe("ANSWER");
    expect(finalAnswer.message?.payload.summary).toContain("[REDACTED_SECRET]");
    expect((finalAnswer.message?.payload.provided_slots as Record<string, string>).config_path).toBe(
      "~/llama/config.json",
    );
  });

  it("preserves askPeer and replyToPeer payloads untouched in trusted mode", async () => {
    const opened = await hostManager.openChannel({
      purpose: "Internal trusted debug",
      trust_mode: "trusted",
      context_summary: "Trusted local debugging",
    });

    const hostWaitHandshake = hostManager.waitForPeer({
      channel_id: opened.channel_id,
      timeout_sec: 5,
    });

    const connected = await seekerManager.connectChannel({
      connect_uri: opened.connect_uri,
    });
    expect(connected.trust_mode).toBe("trusted");
    await hostWaitHandshake;

    const hostWaitQuery = hostManager.waitForPeer({
      channel_id: opened.channel_id,
      timeout_sec: 5,
    });

    const secretInQuestion = "Check token sk-trustedSecretKey1234567890";
    const homePath = "/Users/bob/project/config.json";

    const seekerAsk = seekerManager.askPeer({
      channel_id: connected.channel_id,
      type: "QUERY",
      question: secretInQuestion,
      context_slots: { config_path: homePath },
      timeout_sec: 5,
    });

    const queryMsg = await hostWaitQuery;
    expect(queryMsg.message?.payload.question).toBe(secretInQuestion);
    expect((queryMsg.message?.payload.context_slots as Record<string, string>).config_path).toBe(
      homePath,
    );

    const replySummary = "Use token sk-replyTrustedKey1234567890";
    const replyPath = "/Users/alice/llama/config.json";
    const replyRes = await hostManager.replyToPeer({
      channel_id: opened.channel_id,
      reply_to: queryMsg.message!.message_id,
      type: "ANSWER",
      content: {
        summary: replySummary,
        provided_slots: { config_path: replyPath },
      },
    });

    expect(replyRes.warnings).toEqual([]);

    const answer = await seekerAsk;
    expect(answer.message?.payload.summary).toBe(replySummary);
    expect((answer.message?.payload.provided_slots as Record<string, string>).config_path).toBe(
      replyPath,
    );
  });

  it("rejects invalid URI schemes in connectChannel", async () => {
    await expect(
      seekerManager.connectChannel({
        connect_uri: "wss://relay.example.com/ch_123?token=tok_123",
      }),
    ).rejects.toThrow(/acep:|aceps:/i);

    await expect(
      seekerManager.connectChannel({
        connect_uri: "http://relay.example.com/ch_123?token=tok_123",
      }),
    ).rejects.toThrow(/acep:|aceps:/i);

    await expect(
      seekerManager.connectChannel({
        connect_uri: "not-a-valid-uri",
      }),
    ).rejects.toThrow(/Invalid connect_uri/i);
  });

  it("normalizes https:// relay_url to aceps:// in openChannel and rejects unsupported schemes", async () => {
    await expect(
      hostManager.openChannel({
        purpose: "Bad relay scheme",
        trust_mode: "public",
        context_summary: "test",
        relay_url: "ftp://relay.example.com",
      }),
    ).rejects.toThrow(/relay_url/i);

    const connectSpy = vi
      .spyOn(TunnelClient.prototype, "connect")
      .mockResolvedValue(undefined);
    try {
      const openedHttps = await hostManager.openChannel({
        purpose: "HTTPS normalized relay",
        trust_mode: "public",
        context_summary: "test",
        relay_url: "https://relay.example.com:8443",
      });
      expect(openedHttps.connect_uri).toMatch(/^aceps:\/\/relay\.example\.com:8443\//);
      expect(connectSpy).toHaveBeenCalledWith(
        expect.objectContaining({ relayUrl: "wss://relay.example.com:8443" }),
      );
    } finally {
      connectSpy.mockRestore();
      await hostManager.dispose();
    }

    const { RelayServer } = await import("../src/relay/server.js");
    const relay = new RelayServer();
    const { port } = await relay.start(0);
    try {
      const opened = await hostManager.openChannel({
        purpose: "HTTP normalized relay",
        trust_mode: "public",
        context_summary: "test",
        relay_url: `http://127.0.0.1:${port}`,
      });
      expect(opened.connect_uri).toMatch(new RegExp(`^acep://127\\.0\\.0\\.1:${port}/`));
    } finally {
      await hostManager.dispose();
      await relay.stop();
    }
  });

  it("closes previous client on reconnect and cleans up if HANDSHAKE send fails", async () => {
    const opened = await hostManager.openChannel({
      purpose: "Cleanup test",
      trust_mode: "public",
      context_summary: "test",
    });

    await seekerManager.connectChannel({ connect_uri: opened.connect_uri });

    const closeSpy = vi.spyOn(TunnelClient.prototype, "close");
    const sendSpy = vi
      .spyOn(TunnelClient.prototype, "send")
      .mockImplementationOnce(() => {
        throw new Error("Simulated send failure");
      });

    try {
      await expect(
        seekerManager.connectChannel({ connect_uri: opened.connect_uri }),
      ).rejects.toThrow("Simulated send failure");
      // Both the previous client and the failed new client should have been closed
      expect(closeSpy).toHaveBeenCalledTimes(2);
      // Failed channel must not remain stored
      await expect(
        seekerManager.askPeer({
          channel_id: opened.channel_id,
          type: "QUERY",
          question: "Should fail",
        }),
      ).rejects.toThrow(/Unknown channel/);
    } finally {
      sendSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it("handles concurrent openChannel calls on a fresh manager without racing local relay startup", async () => {
    const [ch1, ch2] = await Promise.all([
      hostManager.openChannel({
        purpose: "First concurrent channel",
        trust_mode: "public",
        context_summary: "first",
      }),
      hostManager.openChannel({
        purpose: "Second concurrent channel",
        trust_mode: "public",
        context_summary: "second",
      }),
    ]);

    const u1 = new URL(ch1.connect_uri);
    const u2 = new URL(ch2.connect_uri);
    expect(u1.host).toBe(u2.host);
    expect(ch1.channel_id).not.toBe(ch2.channel_id);
  });

  it("sanitizes purpose in public mode when opening a channel", async () => {
    const opened = await hostManager.openChannel({
      purpose: "Debug /Users/alice/secret with sk-1234567890abcdefghij",
      trust_mode: "public",
      context_summary: "test",
    });

    const parsed = new URL(opened.connect_uri);
    const decodedPurpose = parsed.searchParams.get("purpose");
    expect(decodedPurpose).toBe("Debug ~/secret with [REDACTED_SECRET]");
  });

  it("exposes an aceps:// URI via cloudflared when expose_public is true and stops it on dispose", async () => {
    let stopped = false;
    let receivedLocalUrl = "";
    const publicManager = new TunnelToolManager({
      startPublicTunnel: async (localHttpUrl) => {
        receivedLocalUrl = localHttpUrl;
        return {
          publicUrl: "https://vm-host-test.trycloudflare.com",
          stop: async () => {
            stopped = true;
          },
        };
      },
    });

    try {
      const opened = await publicManager.openChannel({
        purpose: "VM to agy test",
        trust_mode: "public",
        context_summary: "testing cloudflared",
        expose_public: true,
      });

      expect(receivedLocalUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(opened.connect_uri).toMatch(
        /^aceps:\/\/vm-host-test\.trycloudflare\.com\/ch_/,
      );
    } finally {
      await publicManager.dispose();
    }
    expect(stopped).toBe(true);
  });

  it("rejects combining relay_url and expose_public=true", async () => {
    await expect(
      hostManager.openChannel({
        purpose: "Invalid combination",
        trust_mode: "public",
        context_summary: "test",
        relay_url: "wss://relay.example.com",
        expose_public: true,
      }),
    ).rejects.toThrow(/Cannot specify both relay_url and expose_public=true/);
  });

  it("auto-closes host channel after max_turns replies", async () => {
    const opened = await hostManager.openChannel({
      purpose: "Limit turns test",
      trust_mode: "public",
      context_summary: "test",
      max_turns: 2,
    });
    expect(opened.max_turns).toBe(2);

    const waitHs = hostManager.waitForPeer({
      channel_id: opened.channel_id,
      timeout_sec: 5,
    });
    await seekerManager.connectChannel({ connect_uri: opened.connect_uri });
    await waitHs;

    const waitQ1 = hostManager.waitForPeer({
      channel_id: opened.channel_id,
      timeout_sec: 5,
    });
    const ask1 = seekerManager.askPeer({
      channel_id: opened.channel_id,
      type: "QUERY",
      question: "Q1",
      timeout_sec: 5,
    });
    const q1 = await waitQ1;
    const r1 = await hostManager.replyToPeer({
      channel_id: opened.channel_id,
      reply_to: q1.message!.message_id,
      type: "NEED_INFO",
      content: { reason: "need more", requested_slots: ["os"] },
    });
    expect(r1.turns_remaining).toBe(1);
    expect(r1.closed_by_limit).toBe(false);
    await ask1;

    const waitQ2 = hostManager.waitForPeer({
      channel_id: opened.channel_id,
      timeout_sec: 5,
    });
    const ask2 = seekerManager.askPeer({
      channel_id: opened.channel_id,
      type: "QUERY",
      question: "Q2",
      timeout_sec: 5,
    });
    const q2 = await waitQ2;
    const r2 = await hostManager.replyToPeer({
      channel_id: opened.channel_id,
      reply_to: q2.message!.message_id,
      type: "ANSWER",
      content: { summary: "Final answer" },
    });
    expect(r2.turns_remaining).toBe(0);
    expect(r2.closed_by_limit).toBe(true);

    const a2 = await ask2;
    expect(a2.message?.payload.summary).toBe("Final answer");

    await expect(
      hostManager.waitForPeer({
        channel_id: opened.channel_id,
        timeout_sec: 1,
      }),
    ).rejects.toThrow(/Unknown channel/);
  });

  it("expires host channel after ttl_sec", async () => {
    const opened = await hostManager.openChannel({
      purpose: "TTL expiration test",
      trust_mode: "public",
      context_summary: "test",
      ttl_sec: 0.05,
    });
    expect(opened.ttl_sec).toBe(0.05);

    await new Promise((r) => setTimeout(r, 80));

    await expect(
      hostManager.waitForPeer({
        channel_id: opened.channel_id,
        timeout_sec: 1,
      }),
    ).rejects.toThrow(/Unknown channel|Channel expired/);
  });
});
