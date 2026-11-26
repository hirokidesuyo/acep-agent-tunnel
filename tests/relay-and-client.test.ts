import { describe, it, expect, afterEach } from "vitest";
import { RelayServer } from "../src/relay/server.js";
import { TunnelClient } from "../src/client/tunnel-client.js";
import { createAcepMessage } from "../src/protocol/types.js";

describe("RelayServer & TunnelClient", () => {
  let relay: RelayServer | null = null;

  afterEach(async () => {
    if (relay) {
      await relay.stop();
      relay = null;
    }
  });

  it("relays ACEP messages between host and seeker with matching token", async () => {
    relay = new RelayServer();
    const { url } = await relay.start(0);

    const host = new TunnelClient();
    const seeker = new TunnelClient();

    await host.connect({
      relayUrl: url,
      channelId: "ch_test",
      token: "tok_secret",
      role: "host",
    });

    await seeker.connect({
      relayUrl: url,
      channelId: "ch_test",
      token: "tok_secret",
      role: "seeker",
    });

    const query = createAcepMessage({
      channel_id: "ch_test",
      sender_role: "seeker",
      type: "QUERY",
      payload: { question: "Where is config.json?" },
    });

    seeker.send(query);
    const receivedByHost = await host.waitForMessage(2000);
    expect(receivedByHost?.message_id).toBe(query.message_id);
    expect(receivedByHost?.payload.question).toBe("Where is config.json?");

    const answer = createAcepMessage({
      channel_id: "ch_test",
      sender_role: "host",
      type: "ANSWER",
      reply_to: query.message_id,
      payload: { summary: "It is at src/config.json" },
    });

    host.send(answer);
    const receivedBySeeker = await seeker.waitForMessage(2000);
    expect(receivedBySeeker?.reply_to).toBe(query.message_id);
    expect(receivedBySeeker?.payload.summary).toBe("It is at src/config.json");

    await host.close();
    await seeker.close();
  });

  it("rejects connection with mismatched token", async () => {
    relay = new RelayServer();
    const { url } = await relay.start(0);

    const host = new TunnelClient();
    await host.connect({
      relayUrl: url,
      channelId: "ch_auth",
      token: "correct_token",
      role: "host",
    });

    const intruder = new TunnelClient();
    await expect(
      intruder.connect({
        relayUrl: url,
        channelId: "ch_auth",
        token: "wrong_token",
        role: "seeker",
      })
    ).rejects.toThrow();

    await host.close();
  });

  it("flushes pending waitForMessage waiters with null on close and times out cleanly", async () => {
    relay = new RelayServer();
    const { url } = await relay.start(0);

    const host = new TunnelClient();
    await host.connect({
      relayUrl: url,
      channelId: "ch_close",
      token: "tok_close",
      role: "host",
    });

    const timedOut = await host.waitForMessage(30);
    expect(timedOut).toBeNull();

    const pendingWait = host.waitForMessage(5000);
    await host.close();
    await expect(pendingWait).resolves.toBeNull();
  });

  it("rejects duplicate active role connection on the same channel", async () => {
    relay = new RelayServer();
    const { url } = await relay.start(0);

    const host1 = new TunnelClient();
    await host1.connect({
      relayUrl: url,
      channelId: "ch_dup",
      token: "tok_dup",
      role: "host",
    });

    const host2 = new TunnelClient();
    await expect(
      host2.connect({
        relayUrl: url,
        channelId: "ch_dup",
        token: "tok_dup",
        role: "host",
      }),
    ).rejects.toThrow(/409|4009|already connected/i);

    await host1.close();
  });

  it("drops messages with mismatched sender_role or channel_id", async () => {
    relay = new RelayServer();
    const { url } = await relay.start(0);

    const host = new TunnelClient();
    const seeker = new TunnelClient();
    await host.connect({
      relayUrl: url,
      channelId: "ch_spoof",
      token: "tok_spoof",
      role: "host",
    });
    await seeker.connect({
      relayUrl: url,
      channelId: "ch_spoof",
      token: "tok_spoof",
      role: "seeker",
    });

    // Seeker attempts to spoof sender_role: "host"
    seeker.send(
      createAcepMessage({
        channel_id: "ch_spoof",
        sender_role: "host",
        type: "QUERY",
        payload: { question: "spoofed role" },
      }),
    );

    // Seeker attempts to spoof a different channel_id
    seeker.send(
      createAcepMessage({
        channel_id: "ch_other",
        sender_role: "seeker",
        type: "QUERY",
        payload: { question: "spoofed channel" },
      }),
    );

    const received = await host.waitForMessage(100);
    expect(received).toBeNull();

    await host.close();
    await seeker.close();
  });

  it("returns 400 without crashing on malformed upgrade URL", async () => {
    relay = new RelayServer();
    const { port } = await relay.start(0);
    const net = await import("node:net");

    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
        socket.write(
          "GET http://[invalid HTTP/1.1\r\n" +
            "Host: 127.0.0.1\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString("utf8");
        if (data.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on("error", reject);
    });

    expect(response).toContain("400");
  });
});
