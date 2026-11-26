import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCloudflaredTunnel } from "../src/relay/cloudflared.js";

function createMockChildProcess() {
  const proc = new EventEmitter() as unknown as ChildProcess & {
    stdout: EventEmitter & { resume: () => void; resumed?: boolean };
    stderr: EventEmitter & { resume: () => void; resumed?: boolean };
    exitCode: number | null;
    killed: boolean;
    kill: (signal?: NodeJS.Signals | number) => boolean;
  };
  const stdout = new EventEmitter() as EventEmitter & {
    resume: () => void;
    resumed: boolean;
  };
  stdout.resumed = false;
  stdout.resume = () => {
    stdout.resumed = true;
  };
  const stderr = new EventEmitter() as EventEmitter & {
    resume: () => void;
    resumed: boolean;
  };
  stderr.resumed = false;
  stderr.resume = () => {
    stderr.resumed = true;
  };
  (proc as unknown as { stdout: EventEmitter }).stdout = stdout;
  (proc as unknown as { stderr: EventEmitter }).stderr = stderr;
  (proc as unknown as { exitCode: number | null }).exitCode = null;
  (proc as unknown as { killed: boolean }).killed = false;
  proc.kill = () => {
    (proc as unknown as { killed: boolean }).killed = true;
    (proc as unknown as { exitCode: number | null }).exitCode = 0;
    queueMicrotask(() => proc.emit("exit", 0, null));
    return true;
  };
  return proc;
}

describe("startCloudflaredTunnel", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("waits for both trycloudflare.com URL and Registered tunnel connection before resolving", async () => {
    const mockProc = createMockChildProcess();
    let resolved = false;

    const handlePromise = startCloudflaredTunnel("http://127.0.0.1:8765", {
      spawnFn: () => mockProc,
      timeoutMs: 2000,
    }).then((h) => {
      resolved = true;
      return h;
    });

    mockProc.stderr.emit(
      "data",
      Buffer.from("INF |  https://gentle-river-42.trycloudflare.com                 |\n"),
    );
    await new Promise((r) => setTimeout(r, 15));
    expect(resolved).toBe(false);

    mockProc.stderr.emit(
      "data",
      Buffer.from("INF Registered tunnel connection connIndex=0 connection=abc\n"),
    );

    const handle = await handlePromise;
    expect(handle.publicUrl).toBe("https://gentle-river-42.trycloudflare.com");
    expect(mockProc.stdout.resumed).toBe(true);
    expect(mockProc.stderr.resumed).toBe(true);

    await handle.stop();
    expect(mockProc.killed).toBe(true);
  });

  it("passes --protocol http2 when specified and writes logs to logFile even after resolve", async () => {
    const mockProc = createMockChildProcess();
    let capturedArgs: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "acep-cf-log-"));
    tempDirs.push(dir);
    const logFile = join(dir, "cloudflared.log");

    const handlePromise = startCloudflaredTunnel("http://127.0.0.1:8765", {
      protocol: "http2",
      logFile,
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        return mockProc;
      },
      timeoutMs: 2000,
    });

    expect(capturedArgs).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--protocol",
      "http2",
      "--url",
      "http://127.0.0.1:8765",
    ]);

    mockProc.stderr.emit(
      "data",
      Buffer.from("INF | https://http2-test-123.trycloudflare.com |\n"),
    );
    mockProc.stderr.emit(
      "data",
      Buffer.from("INF Registered tunnel connection connIndex=0\n"),
    );

    const handle = await handlePromise;
    expect(handle.publicUrl).toBe("https://http2-test-123.trycloudflare.com");

    mockProc.stderr.emit("data", Buffer.from("INF post-resolve heartbeat\n"));
    await handle.stop();

    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("https://http2-test-123.trycloudflare.com");
    expect(content).toContain("post-resolve heartbeat");
  });

  it("does not misidentify api.trycloudflare.com error logs as a valid tunnel URL", async () => {
    const mockProc = createMockChildProcess();

    const handlePromise = startCloudflaredTunnel("http://127.0.0.1:8765", {
      spawnFn: () => mockProc,
      timeoutMs: 2000,
    });

    mockProc.stderr.emit(
      "data",
      Buffer.from(
        'ERR Failed to create tunnel error="Post \\"https://api.trycloudflare.com/tunnel\\": dial tcp: i/o timeout"\n',
      ),
    );
    mockProc.emit("exit", 1, null);

    await expect(handlePromise).rejects.toThrow(
      /exited before tunnel became ready/,
    );
  });

  it("throws a helpful error when cloudflared binary is missing (ENOENT)", async () => {
    const mockProc = createMockChildProcess();

    const handlePromise = startCloudflaredTunnel("http://127.0.0.1:8765", {
      spawnFn: () => mockProc,
      timeoutMs: 2000,
    });

    const err = new Error("spawn cloudflared ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockProc.emit("error", err);

    await expect(handlePromise).rejects.toThrow(/cloudflared binary not found/i);
  });

  it("rejects if cloudflared exits before printing a URL", async () => {
    const mockProc = createMockChildProcess();

    const handlePromise = startCloudflaredTunnel("http://127.0.0.1:8765", {
      spawnFn: () => mockProc,
      timeoutMs: 2000,
    });

    mockProc.stderr.emit("data", Buffer.from("ERR failed to connect"));
    mockProc.emit("exit", 1, null);

    await expect(handlePromise).rejects.toThrow(/exited before tunnel became ready/);
  });

  it("rejects and stops process on timeout", async () => {
    const mockProc = createMockChildProcess();

    const handlePromise = startCloudflaredTunnel("http://127.0.0.1:8765", {
      spawnFn: () => mockProc,
      timeoutMs: 30,
    });

    await expect(handlePromise).rejects.toThrow(/Timed out/);
    expect(mockProc.killed).toBe(true);
  });
});
