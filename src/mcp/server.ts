import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TunnelToolManager } from "./tools.js";
import { TrustModeSchema } from "../protocol/types.js";

function jsonTextResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Creates an MCP server instance wired with the five ACEP tunnel tools.
 */
export function createMcpServer(manager = new TunnelToolManager()): {
  server: McpServer;
  manager: TunnelToolManager;
} {
  const server = new McpServer({
    name: "agent-tunnel",
    version: "0.1.0",
  });

  server.registerTool(
    "open_channel",
    {
      description:
        "Open an ACEP consultation channel and return a shareable connect_uri. Set expose_public=true to expose via cloudflared Quick Tunnel for external/VM access. In public mode, do not disclose private source code, credentials, or secrets.",
      inputSchema: {
        purpose: z.string(),
        trust_mode: TrustModeSchema,
        context_summary: z.string(),
        relay_url: z.string().optional(),
        expose_public: z.boolean().optional(),
      },
    },
    async (args) => jsonTextResult(await manager.openChannel(args)),
  );

  server.registerTool(
    "wait_for_peer",
    {
      description: "Wait for an incoming ACEP message from the connected peer",
      inputSchema: {
        channel_id: z.string(),
        timeout_sec: z.number().optional(),
      },
    },
    async (args) => jsonTextResult(await manager.waitForPeer(args)),
  );

  server.registerTool(
    "reply_to_peer",
    {
      description:
        "Send NEED_INFO, ANSWER, or CLOSE back to the connected peer. In public mode, do not disclose private source code, credentials, or secrets.",
      inputSchema: {
        channel_id: z.string(),
        reply_to: z.string(),
        type: z.enum(["NEED_INFO", "ANSWER", "CLOSE"]),
        content: z.record(z.unknown()),
      },
    },
    async (args) => jsonTextResult(await manager.replyToPeer(args)),
  );

  server.registerTool(
    "connect_channel",
    {
      description: "Connect to a peer's ACEP channel using connect_uri",
      inputSchema: {
        connect_uri: z.string(),
      },
    },
    async (args) => jsonTextResult(await manager.connectChannel(args)),
  );

  server.registerTool(
    "ask_peer",
    {
      description: "Send a QUERY or CLOSE message to the host and wait for NEED_INFO or ANSWER",
      inputSchema: {
        channel_id: z.string(),
        type: z.enum(["QUERY", "CLOSE"]),
        question: z.string().optional(),
        context_slots: z.record(z.unknown()).optional(),
        requested_slots: z.array(z.string()).optional(),
        timeout_sec: z.number().optional(),
      },
    },
    async (args) => jsonTextResult(await manager.askPeer(args)),
  );

  return { server, manager };
}

/**
 * Starts the ACEP MCP server over stdio and registers signal shutdown handlers.
 */
export async function startMcpServer(): Promise<void> {
  const { server, manager } = createMcpServer();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.close();
    } finally {
      await manager.dispose();
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void shutdown();
  };
  await server.connect(transport);
}
