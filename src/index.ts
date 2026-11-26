#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startMcpServer } from "./mcp/server.js";
import { RelayServer } from "./relay/server.js";

export function parseRelayPort(args: string[]): number {
  const eqArg = args.find((a) => a.startsWith("--port="));
  let rawPort: string | undefined;

  if (eqArg !== undefined) {
    rawPort = eqArg.slice("--port=".length);
  } else {
    const portIdx = args.indexOf("--port");
    if (portIdx !== -1) {
      rawPort = args[portIdx + 1];
      if (rawPort === undefined) {
        throw new Error("Missing value for --port");
      }
    }
  }

  if (rawPort === undefined) {
    return 8765;
  }

  if (rawPort.trim() === "") {
    throw new Error(`Invalid port: ${rawPort}`);
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${rawPort}`);
  }
  return port;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "relay") {
    const port = parseRelayPort(args.slice(1));
    const relay = new RelayServer();
    const started = await relay.start(port);
    console.error(`ACEP Relay listening on ${started.url}`);

    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await relay.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  await startMcpServer();
}

const isEntrypoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
