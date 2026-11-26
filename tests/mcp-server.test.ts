import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { TunnelToolManager } from "../src/mcp/tools.js";

describe("MCP server (agent-tunnel)", () => {
  let hostManager: TunnelToolManager | null = null;
  let seekerManager: TunnelToolManager | null = null;
  let hostClient: Client | null = null;
  let seekerClient: Client | null = null;

  afterEach(async () => {
    await hostClient?.close();
    await seekerClient?.close();
    await seekerManager?.dispose();
    await hostManager?.dispose();
    hostClient = null;
    seekerClient = null;
    seekerManager = null;
    hostManager = null;
  });

  it("registers all 5 ACEP tools and bridges a full tool call flow", async () => {
    const hostBundle = createMcpServer();
    hostManager = hostBundle.manager;
    const [hostClientTransport, hostServerTransport] = InMemoryTransport.createLinkedPair();
    hostClient = new Client({ name: "test-host-client", version: "0.1.0" });

    await Promise.all([
      hostBundle.server.connect(hostServerTransport),
      hostClient.connect(hostClientTransport),
    ]);

    const toolsList = await hostClient.listTools();
    const toolNames = toolsList.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([
      "ask_peer",
      "connect_channel",
      "open_channel",
      "reply_to_peer",
      "wait_for_peer",
    ]);

    const openResult = await hostClient.callTool({
      name: "open_channel",
      arguments: {
        purpose: "Test MCP bridge",
        trust_mode: "public",
        context_summary: "Testing tool invocation over MCP",
      },
    });
    const openText = (openResult.content as Array<{ type: string; text: string }>)[0].text;
    const opened = JSON.parse(openText) as {
      channel_id: string;
      join_token: string;
      connect_uri: string;
    };
    expect(opened.connect_uri).toMatch(/^acep:\/\//);

    const seekerBundle = createMcpServer();
    seekerManager = seekerBundle.manager;
    const [seekerClientTransport, seekerServerTransport] = InMemoryTransport.createLinkedPair();
    seekerClient = new Client({ name: "test-seeker-client", version: "0.1.0" });

    await Promise.all([
      seekerBundle.server.connect(seekerServerTransport),
      seekerClient.connect(seekerClientTransport),
    ]);

    const hostWaitPromise = hostClient.callTool({
      name: "wait_for_peer",
      arguments: { channel_id: opened.channel_id, timeout_sec: 5 },
    });

    const connectResult = await seekerClient.callTool({
      name: "connect_channel",
      arguments: { connect_uri: opened.connect_uri },
    });
    const connectJson = JSON.parse(
      (connectResult.content as Array<{ type: string; text: string }>)[0].text,
    ) as { channel_id: string; trust_mode: string };
    expect(connectJson.channel_id).toBe(opened.channel_id);
    expect(connectJson.trust_mode).toBe("public");

    const handshakeResult = await hostWaitPromise;
    const handshakeJson = JSON.parse(
      (handshakeResult.content as Array<{ type: string; text: string }>)[0].text,
    ) as { status: string; message: { type: string } };
    expect(handshakeJson.status).toBe("message");
    expect(handshakeJson.message.type).toBe("HANDSHAKE");

    const hostWaitQueryPromise = hostClient.callTool({
      name: "wait_for_peer",
      arguments: { channel_id: opened.channel_id, timeout_sec: 5 },
    });

    const askPromise = seekerClient.callTool({
      name: "ask_peer",
      arguments: {
        channel_id: opened.channel_id,
        type: "QUERY",
        question: "Hello from MCP seeker?",
        timeout_sec: 5,
      },
    });

    const queryResult = await hostWaitQueryPromise;
    const queryJson = JSON.parse(
      (queryResult.content as Array<{ type: string; text: string }>)[0].text,
    ) as { message: { message_id: string; type: string } };
    expect(queryJson.message.type).toBe("QUERY");

    await hostClient.callTool({
      name: "reply_to_peer",
      arguments: {
        channel_id: opened.channel_id,
        reply_to: queryJson.message.message_id,
        type: "ANSWER",
        content: {
          summary: "Hello from MCP host",
          provided_slots: {},
          verification_steps: [],
        },
      },
    });

    const askResult = await askPromise;
    const askJson = JSON.parse(
      (askResult.content as Array<{ type: string; text: string }>)[0].text,
    ) as { message: { type: string; payload: { summary: string } } };
    expect(askJson.message.type).toBe("ANSWER");
    expect(askJson.message.payload.summary).toBe("Hello from MCP host");
  });

  it("rejects empty or whitespace --port= values in parseRelayPort", async () => {
    const { parseRelayPort } = await import("../src/index.js");
    expect(() => parseRelayPort(["--port="])).toThrow(/Invalid port/);
    expect(() => parseRelayPort(["--port=   "])).toThrow(/Invalid port/);
    expect(parseRelayPort(["--port=9000"])).toBe(9000);
    expect(parseRelayPort([])).toBe(8765);
  });

  it("closes MCP server and disposes manager cleanly", async () => {
    const bundle = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-dispose-client", version: "0.1.0" });

    await Promise.all([
      bundle.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    await client.callTool({
      name: "open_channel",
      arguments: {
        purpose: "Dispose test",
        trust_mode: "public",
        context_summary: "test",
      },
    });

    await client.close();
    await bundle.server.close();
    await bundle.manager.dispose();
  });
});
