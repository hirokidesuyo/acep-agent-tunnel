import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";

export type CloudflaredProtocol = "auto" | "quic" | "http2";

export interface PublicTunnelHandle {
  publicUrl: string;
  stop: () => Promise<void>;
}

export type SpawnTunnelProcess = (
  command: string,
  args: string[],
) => ChildProcess;

export interface StartCloudflaredOptions {
  command?: string;
  timeoutMs?: number;
  protocol?: CloudflaredProtocol;
  logFile?: string;
  waitForRegistration?: boolean;
  spawnFn?: SpawnTunnelProcess;
}

const TRY_CLOUDFLARE_URL_RE =
  /https:\/\/(?!api\.trycloudflare\.com\b)[a-z0-9-]+\.trycloudflare\.com\b/i;
const REGISTERED_CONNECTION_RE = /Registered tunnel connection/i;

function resolveProtocol(
  explicit?: CloudflaredProtocol,
): CloudflaredProtocol | undefined {
  const raw = explicit ?? process.env.ACEP_CLOUDFLARED_PROTOCOL?.trim();
  if (!raw) return undefined;
  if (raw === "auto" || raw === "quic" || raw === "http2") {
    return raw;
  }
  throw new Error(
    `Invalid ACEP_CLOUDFLARED_PROTOCOL "${raw}": expected "auto", "quic", or "http2"`,
  );
}

/**
 * Starts a `cloudflared tunnel --url <localHttpUrl>` Quick Tunnel process
 * and resolves once both the `*.trycloudflare.com` URL and initial edge
 * registration (`Registered tunnel connection`) are observed in logs.
 */
export async function startCloudflaredTunnel(
  localHttpUrl: string,
  options: StartCloudflaredOptions = {},
): Promise<PublicTunnelHandle> {
  const command = options.command ?? "cloudflared";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const protocol = resolveProtocol(options.protocol);
  const logFile = options.logFile ?? process.env.ACEP_CLOUDFLARED_LOG_FILE?.trim();
  const waitForRegistration = options.waitForRegistration ?? true;

  const args = ["tunnel", "--no-autoupdate"];
  if (protocol && protocol !== "auto") {
    args.push("--protocol", protocol);
  }
  args.push("--url", localHttpUrl);

  const spawnFn: SpawnTunnelProcess =
    options.spawnFn ??
    ((cmd, spawnArgs) =>
      spawn(cmd, spawnArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      }));

  const logStream: WriteStream | null = logFile
    ? createWriteStream(logFile, { flags: "a" })
    : null;
  logStream?.on("error", () => {
    // Do not crash tunnel lifecycle on auxiliary log write error
  });

  const child = spawnFn(command, args);

  let stopped = false;

  const closeLogStream = async (): Promise<void> => {
    if (!logStream || logStream.closed) return;
    await new Promise<void>((resolve) => {
      logStream.once("error", () => resolve());
      logStream.end(() => resolve());
    });
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode !== null || child.killed) {
      await closeLogStream();
      return;
    }
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore if already exited
        }
        resolve();
      }, 2000);

      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });

      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
    await closeLogStream();
  };

  return new Promise<PublicTunnelHandle>((resolve, reject) => {
    let settled = false;
    let recentOutput = "";
    let foundUrl: string | null = null;
    let hasRegistered = !waitForRegistration;

    const cleanupStartupListeners = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      if (!logStream) {
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        // Keep draining stdout/stderr so cloudflared never blocks on a full pipe buffer
        child.stdout?.resume?.();
        child.stderr?.resume?.();
      }
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupStartupListeners();
      void stop().finally(() => reject(err));
    };

    const maybeResolve = () => {
      if (settled || !foundUrl || !hasRegistered) return;
      settled = true;
      cleanupStartupListeners();
      resolve({
        publicUrl: foundUrl,
        stop,
      });
    };

    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      if (logStream && !logStream.closed) {
        logStream.write(text);
      }
      if (settled) return;

      recentOutput = (recentOutput + text).slice(-2000);
      if (!foundUrl) {
        const match =
          text.match(TRY_CLOUDFLARE_URL_RE) ??
          recentOutput.match(TRY_CLOUDFLARE_URL_RE);
        if (match) {
          foundUrl = match[0];
        }
      }
      if (!hasRegistered) {
        if (
          REGISTERED_CONNECTION_RE.test(text) ||
          REGISTERED_CONNECTION_RE.test(recentOutput)
        ) {
          hasRegistered = true;
        }
      }
      maybeResolve();
    };

    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        fail(
          new Error(
            "cloudflared binary not found. Install cloudflared (e.g., `brew install cloudflared` or official package) to use expose_public.",
          ),
        );
        return;
      }
      fail(new Error(`Failed to start cloudflared: ${err.message}`));
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      void closeLogStream();
      fail(
        new Error(
          `cloudflared exited before tunnel became ready (code=${code}, signal=${signal}). Output: ${recentOutput.trim()}`,
        ),
      );
    };

    const timer = setTimeout(() => {
      fail(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for cloudflared tunnel URL and edge registration.`,
        ),
      );
    }, timeoutMs);

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}
