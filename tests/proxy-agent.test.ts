import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { resolveProxyUrl } from "../src/client/proxy-agent.js";
import { RelayServer } from "../src/relay/server.js";
import { TunnelClient } from "../src/client/tunnel-client.js";
import { createAcepMessage } from "../src/protocol/types.js";

describe("resolveProxyUrl", () => {
  it("resolves HTTPS_PROXY for wss:// targets and bypasses localhost by default", () => {
    const env = {
      HTTPS_PROXY: "http://proxy.internal:3128",
      HTTP_PROXY: "http://proxy-http.internal:3128",
    };

    expect(resolveProxyUrl("wss://example.trycloudflare.com", env)).toBe(
      "http://proxy.internal:3128",
    );
    expect(resolveProxyUrl("ws://127.0.0.1:8765", env)).toBeNull();
    expect(resolveProxyUrl("ws://localhost:8765", env)).toBeNull();
  });

  it("respects NO_PROXY domain and wildcard rules", () => {
    const env = {
      HTTPS_PROXY: "http://proxy.internal:3128",
      NO_PROXY: "internal.local, .corp.example",
    };

    expect(resolveProxyUrl("wss://internal.local/ch", env)).toBeNull();
    expect(resolveProxyUrl("wss://api.corp.example/ch", env)).toBeNull();
    expect(resolveProxyUrl("wss://public.trycloudflare.com/ch", env)).toBe(
      "http://proxy.internal:3128",
    );
  });
});

describe("TunnelClient over HTTP CONNECT proxy", () => {
  let relay: RelayServer | null = null;
  let proxyServer: http.Server | null = null;

  afterEach(async () => {
    if (proxyServer) {
      await new Promise<void>((resolve) => proxyServer!.close(() => resolve()));
      proxyServer = null;
    }
    if (relay) {
      await relay.stop();
      relay = null;
    }
  });

  it("connects and exchanges ACEP messages through an HTTP CONNECT proxy", async () => {
    relay = new RelayServer();
    const { url } = await relay.start(0);

    let connectCount = 0;
    proxyServer = http.createServer();
    proxyServer.on("connect", (req, clientSocket, head) => {
      connectCount++;
      const [host, portStr] = (req.url ?? "").split(":");
      const targetSocket = net.connect(Number(portStr), host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) targetSocket.write(head);
        targetSocket.pipe(clientSocket);
        clientSocket.pipe(targetSocket);
      });
      targetSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => targetSocket.destroy());
    });

    await new Promise<void>((resolve) => {
      proxyServer!.listen(0, "127.0.0.1", () => resolve());
    });
    const proxyPort = (proxyServer.address() as AddressInfo).port;
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    const host = new TunnelClient();
    const seeker = new TunnelClient();

    await host.connect({
      relayUrl: url,
      channelId: "ch_proxy",
      token: "tok_proxy",
      role: "host",
      proxyUrl: null,
    });

    await seeker.connect({
      relayUrl: url,
      channelId: "ch_proxy",
      token: "tok_proxy",
      role: "seeker",
      proxyUrl,
    });

    expect(connectCount).toBe(1);

    const query = createAcepMessage({
      channel_id: "ch_proxy",
      sender_role: "seeker",
      type: "QUERY",
      payload: { question: "Hello via proxy" },
    });
    seeker.send(query);

    const received = await host.waitForMessage(2000);
    expect(received?.payload.question).toBe("Hello via proxy");

    await host.close();
    await seeker.close();
  });
});
