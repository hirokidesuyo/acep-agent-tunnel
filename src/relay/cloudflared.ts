import { spawn, type ChildProcess } from "node:child_process";

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
  spawnFn?: SpawnTunnelProcess;
}

const TRY_CLOUDFLARE_URL_RE =
  /https:\/\/(?!api\.trycloudflare\.com\b)[a-z0-9-]+\.trycloudflare\.com\b/i;

/**
 * Starts a `cloudflared tunnel --url <localHttpUrl>` Quick Tunnel process
 * and resolves once the generated `*.trycloudflare.com` URL appears in logs.
 */
export async function startCloudflaredTunnel(
  localHttpUrl: string,
  options: StartCloudflaredOptions = {},
): Promise<PublicTunnelHandle> {
  const command = options.command ?? "cloudflared";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const spawnFn: SpawnTunnelProcess =
    options.spawnFn ??
    ((cmd, args) =>
      spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
      }));

  const child = spawnFn(command, [
    "tunnel",
    "--no-autoupdate",
    "--url",
    localHttpUrl,
  ]);

  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode !== null || child.killed) {
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
  };

  return new Promise<PublicTunnelHandle>((resolve, reject) => {
    let settled = false;
    let recentOutput = "";

    const cleanupListeners = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      void stop().finally(() => reject(err));
    };

    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      recentOutput = (recentOutput + text).slice(-2000);
      const match = text.match(TRY_CLOUDFLARE_URL_RE) ?? recentOutput.match(TRY_CLOUDFLARE_URL_RE);
      if (match && !settled) {
        settled = true;
        cleanupListeners();
        // Keep draining stdout/stderr so cloudflared never blocks on a full pipe buffer
        child.stdout?.resume?.();
        child.stderr?.resume?.();
        resolve({
          publicUrl: match[0],
          stop,
        });
      }
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
      fail(
        new Error(
          `cloudflared exited before providing a tunnel URL (code=${code}, signal=${signal}). Output: ${recentOutput.trim()}`,
        ),
      );
    };

    const timer = setTimeout(() => {
      fail(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for cloudflared tunnel URL.`,
        ),
      );
    }, timeoutMs);

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}
