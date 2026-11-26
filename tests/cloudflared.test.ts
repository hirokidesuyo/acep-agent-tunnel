import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { startCloudflaredTunnel } from "../src/relay/cloudflared.js";

function createMockChildProcess() {
  const proc = new EventEmitter() as unknown as ChildProcess & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    killed: boolean;
    kill: (signal?: NodeJS.Signals | number) => boolean;
  };
  (proc as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (proc as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
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
  it("resolves with the trycloudflare.com URL emitted on stderr and stops cleanly", async () => {
    const mockProc = createMockChildProcess();

    const handlePromise = startCloudflaredTunnel("http://127.0.0.1:8765", {
      spawnFn: () => mockProc,
      timeoutMs: 2000,
    });

    mockProc.stderr.emit(
      "data",
      Buffer.from("INF +------------------------------------------------------------+\n"),
    );
    mockProc.stderr.emit(
      "data",
      Buffer.from("INF |  https://gentle-river-42.trycloudflare.com                 |\n"),
    );

    const handle = await handlePromise;
    expect(handle.publicUrl).toBe("https://gentle-river-42.trycloudflare.com");

    await handle.stop();
    expect(mockProc.killed).toBe(true);
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

    await expect(handlePromise).rejects.toThrow(/exited before providing a tunnel URL/);
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
