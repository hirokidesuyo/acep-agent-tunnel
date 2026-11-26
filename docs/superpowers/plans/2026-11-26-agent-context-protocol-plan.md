# Agent Context Exchange Protocol (ACEP) & MCPブリッジ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenCode / Codex / Gemini / Antigravity 等のセッション同士が、ローカルおよびネットワーク越しに過不足ない文脈だけを構造化して対話・共有できる ACEP プロトコル、WebSocket リレー、および MCP サーバーを TypeScript で構築する。

**Architecture:** 3層構成を採用する。(1) `src/protocol/` で Zod ベースの ACEP メッセージ形式を定義し、(2) `src/relay/` と `src/client/` でワンタイムトークン付きの WebSocket 中継・待機キューを提供し、(3) `src/mcp/` で 5つの MCP ツール（`open_channel`, `wait_for_peer`, `reply_to_peer`, `connect_channel`, `ask_peer`）を公開する。`public` モード時は `src/security/sanitizer.ts` により機密情報・絶対パスを自動マスクする。

**Tech Stack:** TypeScript (ESM), Node.js 20+, `@modelcontextprotocol/sdk`, `ws`, `zod`, `vitest`

**Spec:** [2026-11-26-agent-context-protocol-design.md](../specs/2026-11-26-agent-context-protocol-design.md)

## Global Constraints

- Node.js 20+ / TypeScript ESM 構成 (`"type": "module"`)
- プロトコルバージョンは `"acep/1.0"` を厳守する
- すべての外部入力（WebSocketメッセージ・MCPツール引数）は `zod` で検証する
- `public` モードでは APIキー・トークン・秘密鍵・ホームディレクトリの絶対パスを送信前に必ずサニタイズする
- 実装は TDD（失敗するテスト → 最小実装 → テスト通過 → コミット）で進める

---

## ファイル構成マップ

- `package.json`, `tsconfig.json`, `vitest.config.ts`: プロジェクト設定
- `src/protocol/types.ts`: ACEP メッセージ型・Zod スキーマ・エンベロープ生成ヘルパー
- `src/security/sanitizer.ts`: `public` モード用サニタイザ（秘密鍵・APIキー・ユーザーパス等のマスク）
- `src/relay/server.ts`: チャネル管理と双方向ルーティングを行う WebSocket リレーサーバー
- `src/client/tunnel-client.ts`: リレー接続・待機キュー・タイムアウト管理を行うクライアント
- `src/mcp/tools.ts`: 5つの MCP ツールロジック（状態管理・リレー自動起動・サニタイズ連携）
- `src/mcp/server.ts`: `@modelcontextprotocol/sdk` を使った stdio MCP サーバー
- `src/index.ts`: CLI エントリポイント（`mcp` / `relay` モード）
- `tests/protocol.test.ts`, `tests/sanitizer.test.ts`, `tests/relay-and-client.test.ts`, `tests/mcp-tools.test.ts`: 各層テスト

---

### Task 1: プロジェクト初期化 ＋ ACEPプロトコル定義

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/protocol/types.ts`
- Test: `tests/protocol.test.ts`

**Interfaces:**
- Produces:
  - `ACEP_PROTOCOL_VERSION = "acep/1.0"`
  - `TrustModeSchema`, `SenderRoleSchema`, `MessageTypeSchema`, `AcepMessageSchema`
  - `createAcepMessage(params)`
  - TypeScript types: `TrustMode`, `SenderRole`, `MessageType`, `AcepMessage`

- [ ] **Step 1: プロジェクト設定ファイルを作成する**

`package.json`:
```json
{
  "name": "agent-tunnel",
  "version": "0.1.0",
  "description": "ACEP (Agent Context Exchange Protocol) & MCP bridge for agent-to-agent dialogue",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "agent-tunnel": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "ws": "^8.18.0",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/ws": "^8.5.14",
    "typescript": "^5.7.2",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: 依存関係をインストールし、Gitリポジトリを初期化する**

Run: `cd /path/to/acep-agent-tunnel && git init && npm install`
Expected: `node_modules` が作成され、エラーなく完了する

- [ ] **Step 3: 失敗するテストを書く (`tests/protocol.test.ts`)**

```ts
import { describe, it, expect } from "vitest";
import {
  ACEP_PROTOCOL_VERSION,
  AcepMessageSchema,
  createAcepMessage,
} from "../src/protocol/types.js";

describe("ACEP Protocol", () => {
  it("creates and validates a QUERY message", () => {
    const msg = createAcepMessage({
      channel_id: "ch_123",
      sender_role: "seeker",
      type: "QUERY",
      payload: {
        question: "Why is Gemma running at 50 tok/s?",
        context_slots: { gpu: "RTX4090", backend: "llama.cpp" },
        requested_slots: ["quantization", "launch_args"],
      },
    });

    expect(msg.protocol).toBe(ACEP_PROTOCOL_VERSION);
    expect(msg.channel_id).toBe("ch_123");
    expect(msg.message_id).toMatch(/^msg_/);
    expect(AcepMessageSchema.parse(msg)).toEqual(msg);
  });

  it("rejects invalid protocol version", () => {
    const invalid = {
      protocol: "acep/9.9",
      channel_id: "ch_123",
      message_id: "msg_1",
      reply_to: null,
      sender_role: "seeker",
      type: "QUERY",
      timestamp: new Date().toISOString(),
      payload: { question: "hi" },
    };
    expect(() => AcepMessageSchema.parse(invalid)).toThrow();
  });
});
```

- [ ] **Step 4: テストを実行し、失敗することを確認する**

Run: `npx vitest run tests/protocol.test.ts`
Expected: FAIL (`Cannot find module '../src/protocol/types.js'`)

- [ ] **Step 5: `src/protocol/types.ts` を実装する**

```ts
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const ACEP_PROTOCOL_VERSION = "acep/1.0" as const;

export const TrustModeSchema = z.enum(["trusted", "public"]);
export type TrustMode = z.infer<typeof TrustModeSchema>;

export const SenderRoleSchema = z.enum(["host", "seeker"]);
export type SenderRole = z.infer<typeof SenderRoleSchema>;

export const MessageTypeSchema = z.enum([
  "HANDSHAKE",
  "QUERY",
  "NEED_INFO",
  "ANSWER",
  "CLOSE",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const HandshakePayloadSchema = z.object({
  purpose: z.string(),
  trust_mode: TrustModeSchema,
  capabilities: z.array(z.string()).default([]),
  context_summary: z.string().optional(),
});

export const QueryPayloadSchema = z.object({
  question: z.string(),
  context_slots: z.record(z.unknown()).default({}),
  requested_slots: z.array(z.string()).default([]),
});

export const NeedInfoPayloadSchema = z.object({
  reason: z.string(),
  requested_slots: z.array(z.string()).min(1),
});

export const AnswerPayloadSchema = z.object({
  summary: z.string(),
  provided_slots: z.record(z.unknown()).default({}),
  verification_steps: z.array(z.string()).default([]),
});

export const ClosePayloadSchema = z.object({
  reason: z.enum(["resolved", "timeout", "cancelled"]),
});

export const AcepMessageSchema = z.object({
  protocol: z.literal(ACEP_PROTOCOL_VERSION),
  channel_id: z.string().min(1),
  message_id: z.string().min(1),
  reply_to: z.string().nullable().default(null),
  sender_role: SenderRoleSchema,
  type: MessageTypeSchema,
  timestamp: z.string(),
  payload: z.record(z.unknown()),
});

export type AcepMessage = z.infer<typeof AcepMessageSchema>;

export function createAcepMessage(params: {
  channel_id: string;
  sender_role: SenderRole;
  type: MessageType;
  payload: Record<string, unknown>;
  reply_to?: string | null;
}): AcepMessage {
  return {
    protocol: ACEP_PROTOCOL_VERSION,
    channel_id: params.channel_id,
    message_id: `msg_${randomUUID().slice(0, 12)}`,
    reply_to: params.reply_to ?? null,
    sender_role: params.sender_role,
    type: params.type,
    timestamp: new Date().toISOString(),
    payload: params.payload,
  };
}
```

- [ ] **Step 6: テストを実行し、通過することを確認する**

Run: `npx vitest run tests/protocol.test.ts`
Expected: PASS (2 tests passed)

- [ ] **Step 7: コミットする**

```bash
git add package.json tsconfig.json vitest.config.ts src/protocol/types.ts tests/protocol.test.ts
git commit -m "feat: initialize project and add ACEP protocol schema"
```

---

### Task 2: `public` モード用セキュリティサニタイザ

**Files:**
- Create: `src/security/sanitizer.ts`
- Test: `tests/sanitizer.test.ts`

**Interfaces:**
- Produces:
  - `SanitizeResult`: `{ sanitized: T; warnings: string[] }`
  - `sanitizeForPublic<T>(data: T): SanitizeResult<T>`

- [ ] **Step 1: 失敗するテストを書く (`tests/sanitizer.test.ts`)**

```ts
import { describe, it, expect } from "vitest";
import { sanitizeForPublic } from "../src/security/sanitizer.js";

describe("sanitizeForPublic", () => {
  it("masks API keys, tokens, private keys, and user home paths", () => {
    const input = {
      summary: "Use key sk-1234567890abcdefghij and token ghp_abcdef1234567890",
      path: "/Users/alice/secret-repo/config.json",
      nested: {
        winPath: "C:\\Users\\alice\\project\\env",
        pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
      },
    };

    const { sanitized, warnings } = sanitizeForPublic(input);

    expect(sanitized.summary).not.toContain("sk-1234567890abcdefghij");
    expect(sanitized.summary).not.toContain("ghp_abcdef1234567890");
    expect(sanitized.summary).toContain("[REDACTED_SECRET]");
    expect(sanitized.path).toBe("~/secret-repo/config.json");
    expect(sanitized.nested.winPath).toBe("~/project/env");
    expect(sanitized.nested.pem).toBe("[REDACTED_PRIVATE_KEY]");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("leaves safe technical strings untouched with zero warnings", () => {
    const input = {
      summary: "Pass --flash-attn and use Q4_K_M quantization",
      args: ["--threads", "8"],
    };

    const { sanitized, warnings } = sanitizeForPublic(input);
    expect(sanitized).toEqual(input);
    expect(warnings).toEqual([]);
  });
});
```

- [ ] **Step 2: テストを実行し、失敗することを確認する**

Run: `npx vitest run tests/sanitizer.test.ts`
Expected: FAIL (`Cannot find module '../src/security/sanitizer.js'`)

- [ ] **Step 3: `src/security/sanitizer.ts` を実装する**

```ts
export interface SanitizeResult<T> {
  sanitized: T;
  warnings: string[];
}

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  {
    name: "private_key",
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    name: "openai_or_sk_key",
    regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    replacement: "[REDACTED_SECRET]",
  },
  {
    name: "github_token",
    regex: /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g,
    replacement: "[REDACTED_SECRET]",
  },
  {
    name: "google_api_key",
    regex: /\bAIza[0-9A-Za-z_-]{20,}\b/g,
    replacement: "[REDACTED_SECRET]",
  },
  {
    name: "bearer_token",
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    replacement: "Bearer [REDACTED_SECRET]",
  },
  {
    name: "unix_home_path",
    regex: /\/(?:Users|home)\/[^/\s"']+/g,
    replacement: "~",
  },
  {
    name: "windows_home_path",
    regex: /[A-Za-z]:\\Users\\[^\\\s"']+/g,
    replacement: "~",
  },
];

function sanitizeString(value: string, warnings: Set<string>): string {
  let result = value;
  for (const rule of SECRET_PATTERNS) {
    if (rule.regex.test(result)) {
      rule.regex.lastIndex = 0;
      result = result.replace(rule.regex, (...args) => {
        if (rule.name === "windows_home_path") {
          return "~";
        }
        return rule.replacement;
      });
      warnings.add(`Redacted ${rule.name}`);
    }
    rule.regex.lastIndex = 0;
  }
  if (result.includes("~\\")) {
    result = result.replace(/~\\([^\s"']*)/g, (_, rest: string) => `~/${rest.replace(/\\/g, "/")}`);
  }
  return result;
}

function walkAndSanitize(value: unknown, warnings: Set<string>): unknown {
  if (typeof value === "string") {
    return sanitizeString(value, warnings);
  }
  if (Array.isArray(value)) {
    return value.map((item) => walkAndSanitize(item, warnings));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = walkAndSanitize(v, warnings);
    }
    return out;
  }
  return value;
}

export function sanitizeForPublic<T>(data: T): SanitizeResult<T> {
  const warnings = new Set<string>();
  const sanitized = walkAndSanitize(data, warnings) as T;
  return {
    sanitized,
    warnings: Array.from(warnings),
  };
}
```

- [ ] **Step 4: テストを実行し、通過することを確認する**

Run: `npx vitest run tests/sanitizer.test.ts`
Expected: PASS (2 tests passed)

- [ ] **Step 5: コミットする**

```bash
git add src/security/sanitizer.ts tests/sanitizer.test.ts
git commit -m "feat: add public mode sanitizer for secrets and user paths"
```

---

### Task 3: WebSocket リレーサーバー ＋ トンネルクライアント

**Files:**
- Create: `src/relay/server.ts`
- Create: `src/client/tunnel-client.ts`
- Test: `tests/relay-and-client.test.ts`

**Interfaces:**
- Consumes: `AcepMessageSchema`, `AcepMessage`, `SenderRole` from `src/protocol/types.ts`
- Produces:
  - `RelayServer`: `start(port?: number): Promise<{ port: number; url: string }>`, `stop(): Promise<void>`
  - `TunnelClient`: `connect(params: { relayUrl: string; channelId: string; token: string; role: SenderRole }): Promise<void>`, `send(msg: AcepMessage): void`, `waitForMessage(timeoutMs?: number): Promise<AcepMessage | null>`, `close(): Promise<void>`

- [ ] **Step 1: 失敗するテストを書く (`tests/relay-and-client.test.ts`)**

```ts
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
});
```

- [ ] **Step 2: テストを実行し、失敗することを確認する**

Run: `npx vitest run tests/relay-and-client.test.ts`
Expected: FAIL (`Cannot find module '../src/relay/server.js'`)

- [ ] **Step 3: `src/relay/server.ts` を実装する**

```ts
import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { AcepMessageSchema, type SenderRole } from "../protocol/types.js";

interface ChannelRoom {
  token: string;
  host: WebSocket | null;
  seeker: WebSocket | null;
}

export class RelayServer {
  private wss: WebSocketServer | null = null;
  private rooms = new Map<string, ChannelRoom>();

  async start(port = 0): Promise<{ port: number; url: string }> {
    if (this.wss) {
      const addr = this.wss.address() as AddressInfo;
      return { port: addr.port, url: `ws://127.0.0.1:${addr.port}` };
    }

    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port });
      this.wss = wss;

      wss.once("error", reject);
      wss.once("listening", () => {
        const addr = wss.address() as AddressInfo;
        resolve({ port: addr.port, url: `ws://127.0.0.1:${addr.port}` });
      });

      wss.on("connection", (ws, req) => {
        const reqUrl = new URL(req.url ?? "/", "ws://127.0.0.1");
        const channelId = reqUrl.searchParams.get("channel_id");
        const token = reqUrl.searchParams.get("token");
        const role = reqUrl.searchParams.get("role") as SenderRole | null;

        if (!channelId || !token || (role !== "host" && role !== "seeker")) {
          ws.close(4000, "Missing channel_id, token, or valid role");
          return;
        }

        let room = this.rooms.get(channelId);
        if (!room) {
          room = { token, host: null, seeker: null };
          this.rooms.set(channelId, room);
        } else if (room.token !== token) {
          ws.close(4001, "Invalid token");
          return;
        }

        room[role] = ws;

        ws.on("message", (raw) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString("utf8"));
          } catch {
            return;
          }
          const result = AcepMessageSchema.safeParse(parsed);
          if (!result.success) return;

          const peerRole: SenderRole = role === "host" ? "seeker" : "host";
          const peer = room?.[peerRole];
          if (peer && peer.readyState === WebSocket.OPEN) {
            peer.send(JSON.stringify(result.data));
          }
        });

        ws.on("close", () => {
          if (room && room[role] === ws) {
            room[role] = null;
            if (!room.host && !room.seeker) {
              this.rooms.delete(channelId);
            }
          }
        });
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.wss) return;
    const wss = this.wss;
    this.wss = null;
    this.rooms.clear();
    return new Promise((resolve) => {
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close(() => resolve());
    });
  }
}
```

- [ ] **Step 4: `src/client/tunnel-client.ts` を実装する**

```ts
import { WebSocket } from "ws";
import { AcepMessageSchema, type AcepMessage, type SenderRole } from "../protocol/types.js";

export class TunnelClient {
  private ws: WebSocket | null = null;
  private queue: AcepMessage[] = [];
  private waiters: Array<(msg: AcepMessage | null) => void> = [];

  async connect(params: {
    relayUrl: string;
    channelId: string;
    token: string;
    role: SenderRole;
  }): Promise<void> {
    const base = params.relayUrl.replace(/\/$/, "");
    const wsUrl = `${base}/?channel_id=${encodeURIComponent(params.channelId)}&token=${encodeURIComponent(params.token)}&role=${params.role}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;

      ws.once("open", () => {
        settled = true;
        this.ws = ws;
        resolve();
      });

      ws.once("close", (code, reason) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Connection rejected (${code}): ${reason.toString()}`));
        }
        this.flushWaitersWithNull();
      });

      ws.once("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ws.on("message", (raw) => {
        try {
          const parsed = AcepMessageSchema.parse(JSON.parse(raw.toString("utf8")));
          const waiter = this.waiters.shift();
          if (waiter) {
            waiter(parsed);
          } else {
            this.queue.push(parsed);
          }
        } catch {
          // Ignore malformed payloads
        }
      });
    });
  }

  send(msg: AcepMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("TunnelClient is not connected");
    }
    this.ws.send(JSON.stringify(msg));
  }

  async waitForMessage(timeoutMs = 120_000): Promise<AcepMessage | null> {
    if (this.queue.length > 0) {
      return this.queue.shift() ?? null;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return null;
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(onMessage);
        if (idx !== -1) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      const onMessage = (msg: AcepMessage | null) => {
        clearTimeout(timer);
        resolve(msg);
      };

      this.waiters.push(onMessage);
    });
  }

  private flushWaitersWithNull(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.(null);
    }
  }

  async close(): Promise<void> {
    this.flushWaitersWithNull();
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    if (ws.readyState === WebSocket.CLOSED) return;
    return new Promise((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
  }
}
```

- [ ] **Step 5: テストを実行し、通過することを確認する**

Run: `npx vitest run tests/relay-and-client.test.ts`
Expected: PASS (2 tests passed)

- [ ] **Step 6: コミットする**

```bash
git add src/relay/server.ts src/client/tunnel-client.ts tests/relay-and-client.test.ts
git commit -m "feat: implement WebSocket relay server and TunnelClient"
```

---

### Task 4: 5つのMCPツールハンドラ実装 ＋ 2エージェント対話統合テスト

**Files:**
- Create: `src/mcp/tools.ts`
- Test: `tests/mcp-tools.test.ts`

**Interfaces:**
- Consumes: `RelayServer`, `TunnelClient`, `sanitizeForPublic`, `createAcepMessage`, `TrustMode`
- Produces:
  - `TunnelToolManager` class with methods:
    - `openChannel(args)`
    - `waitForPeer(args)`
    - `replyToPeer(args)`
    - `connectChannel(args)`
    - `askPeer(args)`
    - `dispose(): Promise<void>`

- [ ] **Step 1: 失敗するテストを書く (`tests/mcp-tools.test.ts`)**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { TunnelToolManager } from "../src/mcp/tools.js";

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
      question: "Why am I getting 50 tok/s?",
      context_slots: { gpu: "RTX4090", backend: "llama.cpp" },
      requested_slots: ["launch_args"],
      timeout_sec: 5,
    });

    const queryMsg1 = await hostWaitQuery;
    expect(queryMsg1.message?.type).toBe("QUERY");

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
      "~/llama/config.json"
    );
  });
});
```

- [ ] **Step 2: テストを実行し、失敗することを確認する**

Run: `npx vitest run tests/mcp-tools.test.ts`
Expected: FAIL (`Cannot find module '../src/mcp/tools.js'`)

- [ ] **Step 3: `src/mcp/tools.ts` を実装する**

```ts
import { randomBytes } from "node:crypto";
import {
  createAcepMessage,
  type AcepMessage,
  type TrustMode,
} from "../protocol/types.js";
import { RelayServer } from "../relay/server.js";
import { TunnelClient } from "../client/tunnel-client.js";
import { sanitizeForPublic } from "../security/sanitizer.js";

interface ManagedChannel {
  channel_id: string;
  role: "host" | "seeker";
  trust_mode: TrustMode;
  purpose: string;
  client: TunnelClient;
}

export class TunnelToolManager {
  private localRelay: RelayServer | null = null;
  private localRelayUrl: string | null = null;
  private channels = new Map<string, ManagedChannel>();

  private async ensureLocalRelay(): Promise<string> {
    if (!this.localRelay) {
      this.localRelay = new RelayServer();
      const started = await this.localRelay.start(0);
      this.localRelayUrl = started.url;
    }
    return this.localRelayUrl!;
  }

  async openChannel(args: {
    purpose: string;
    trust_mode: TrustMode;
    context_summary: string;
    relay_url?: string;
  }): Promise<{ channel_id: string; join_token: string; connect_uri: string }> {
    const relayUrl = args.relay_url ?? (await this.ensureLocalRelay());
    const channelId = `ch_${randomBytes(6).toString("hex")}`;
    const joinToken = `tok_${randomBytes(12).toString("hex")}`;

    const client = new TunnelClient();
    await client.connect({
      relayUrl,
      channelId,
      token: joinToken,
      role: "host",
    });

    this.channels.set(channelId, {
      channel_id: channelId,
      role: "host",
      trust_mode: args.trust_mode,
      purpose: args.purpose,
      client,
    });

    const parsedRelay = new URL(relayUrl);
    const scheme = parsedRelay.protocol === "wss:" ? "aceps" : "acep";
    const connectUri = `${scheme}://${parsedRelay.host}/${channelId}?token=${joinToken}&trust=${args.trust_mode}&purpose=${encodeURIComponent(args.purpose)}`;

    return {
      channel_id: channelId,
      join_token: joinToken,
      connect_uri: connectUri,
    };
  }

  async waitForPeer(args: {
    channel_id: string;
    timeout_sec?: number;
  }): Promise<{ status: "message" | "timeout"; message: AcepMessage | null }> {
    const ch = this.channels.get(args.channel_id);
    if (!ch) throw new Error(`Unknown channel: ${args.channel_id}`);

    const msg = await ch.client.waitForMessage((args.timeout_sec ?? 120) * 1000);
    if (!msg) {
      return { status: "timeout", message: null };
    }
    return { status: "message", message: msg };
  }

  async replyToPeer(args: {
    channel_id: string;
    reply_to: string;
    type: "NEED_INFO" | "ANSWER" | "CLOSE";
    content: Record<string, unknown>;
  }): Promise<{ sent: boolean; message_id: string; warnings: string[] }> {
    const ch = this.channels.get(args.channel_id);
    if (!ch) throw new Error(`Unknown channel: ${args.channel_id}`);

    let payload = args.content;
    let warnings: string[] = [];

    if (ch.trust_mode === "public") {
      const res = sanitizeForPublic(args.content);
      payload = res.sanitized;
      warnings = res.warnings;
    }

    const msg = createAcepMessage({
      channel_id: ch.channel_id,
      sender_role: ch.role,
      type: args.type,
      reply_to: args.reply_to,
      payload,
    });

    ch.client.send(msg);
    return { sent: true, message_id: msg.message_id, warnings };
  }

  async connectChannel(args: {
    connect_uri: string;
  }): Promise<{ channel_id: string; host_purpose: string; trust_mode: TrustMode }> {
    const uri = new URL(args.connect_uri);
    const wsProtocol = uri.protocol === "aceps:" ? "wss:" : "ws:";
    const relayUrl = `${wsProtocol}//${uri.host}`;
    const channelId = uri.pathname.replace(/^\//, "");
    const token = uri.searchParams.get("token");
    const trustMode = (uri.searchParams.get("trust") as TrustMode) ?? "public";
    const purpose = uri.searchParams.get("purpose") ?? "General consultation";

    if (!channelId || !token) {
      throw new Error("Invalid connect_uri: missing channel_id or token");
    }

    const client = new TunnelClient();
    await client.connect({
      relayUrl,
      channelId,
      token,
      role: "seeker",
    });

    this.channels.set(channelId, {
      channel_id: channelId,
      role: "seeker",
      trust_mode: trustMode,
      purpose,
      client,
    });

    const handshake = createAcepMessage({
      channel_id: channelId,
      sender_role: "seeker",
      type: "HANDSHAKE",
      payload: {
        purpose,
        trust_mode: trustMode,
        capabilities: ["acep/1.0"],
      },
    });
    client.send(handshake);

    return {
      channel_id: channelId,
      host_purpose: purpose,
      trust_mode: trustMode,
    };
  }

  async askPeer(args: {
    channel_id: string;
    type: "QUERY" | "CLOSE";
    question?: string;
    context_slots?: Record<string, unknown>;
    requested_slots?: string[];
    timeout_sec?: number;
  }): Promise<{ status: "message" | "timeout"; message: AcepMessage | null }> {
    const ch = this.channels.get(args.channel_id);
    if (!ch) throw new Error(`Unknown channel: ${args.channel_id}`);

    const rawPayload =
      args.type === "CLOSE"
        ? { reason: "resolved" }
        : {
            question: args.question ?? "",
            context_slots: args.context_slots ?? {},
            requested_slots: args.requested_slots ?? [],
          };

    const payload =
      ch.trust_mode === "public" ? sanitizeForPublic(rawPayload).sanitized : rawPayload;

    const msg = createAcepMessage({
      channel_id: ch.channel_id,
      sender_role: ch.role,
      type: args.type,
      payload,
    });
    ch.client.send(msg);

    if (args.type === "CLOSE") {
      return { status: "message", message: msg };
    }

    const reply = await ch.client.waitForMessage((args.timeout_sec ?? 60) * 1000);
    if (!reply) {
      return { status: "timeout", message: null };
    }
    return { status: "message", message: reply };
  }

  async dispose(): Promise<void> {
    for (const ch of this.channels.values()) {
      await ch.client.close();
    }
    this.channels.clear();
    if (this.localRelay) {
      await this.localRelay.stop();
      this.localRelay = null;
      this.localRelayUrl = null;
    }
  }
}
```

- [ ] **Step 4: テストを実行し、通過することを確認する**

Run: `npx vitest run tests/mcp-tools.test.ts`
Expected: PASS (1 test passed)

- [ ] **Step 5: コミットする**

```bash
git add src/mcp/tools.ts tests/mcp-tools.test.ts
git commit -m "feat: implement TunnelToolManager for 5 MCP tools with public sanitization"
```

---

### Task 5: MCPサーバーエントリポイント・CLI・ビルド確認・README

**Files:**
- Create: `src/mcp/server.ts`
- Create: `src/index.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: `TunnelToolManager`, `RelayServer`, `TrustModeSchema`
- Produces:
  - `startMcpServer(): Promise<void>`
  - CLI (`agent-tunnel` / `agent-tunnel relay --port 8765`)

- [ ] **Step 1: `src/mcp/server.ts` を実装する**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TunnelToolManager } from "./tools.js";
import { TrustModeSchema } from "../protocol/types.js";

export async function startMcpServer(): Promise<void> {
  const manager = new TunnelToolManager();
  const server = new McpServer({
    name: "agent-tunnel",
    version: "0.1.0",
  });

  server.tool(
    "open_channel",
    "Open an ACEP consultation channel and return a shareable connect_uri",
    {
      purpose: z.string(),
      trust_mode: TrustModeSchema,
      context_summary: z.string(),
      relay_url: z.string().optional(),
    },
    async (args) => {
      const res = await manager.openChannel(args);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
  );

  server.tool(
    "wait_for_peer",
    "Wait for an incoming ACEP message from the connected peer",
    {
      channel_id: z.string(),
      timeout_sec: z.number().optional(),
    },
    async (args) => {
      const res = await manager.waitForPeer(args);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
  );

  server.tool(
    "reply_to_peer",
    "Send NEED_INFO, ANSWER, or CLOSE back to the connected peer",
    {
      channel_id: z.string(),
      reply_to: z.string(),
      type: z.enum(["NEED_INFO", "ANSWER", "CLOSE"]),
      content: z.record(z.unknown()),
    },
    async (args) => {
      const res = await manager.replyToPeer(args);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
  );

  server.tool(
    "connect_channel",
    "Connect to a peer's ACEP channel using connect_uri",
    {
      connect_uri: z.string(),
    },
    async (args) => {
      const res = await manager.connectChannel(args);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
  );

  server.tool(
    "ask_peer",
    "Send a QUERY or CLOSE message to the host and wait for NEED_INFO or ANSWER",
    {
      channel_id: z.string(),
      type: z.enum(["QUERY", "CLOSE"]),
      question: z.string().optional(),
      context_slots: z.record(z.unknown()).optional(),
      requested_slots: z.array(z.string()).optional(),
      timeout_sec: z.number().optional(),
    },
    async (args) => {
      const res = await manager.askPeer(args);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
  );

  const shutdown = async () => {
    await manager.dispose();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 2: `src/index.ts` を実装する**

```ts
#!/usr/bin/env node
import { startMcpServer } from "./mcp/server.js";
import { RelayServer } from "./relay/server.js";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "relay") {
    const portIdx = args.indexOf("--port");
    const port = portIdx !== -1 ? Number(args[portIdx + 1]) : 8765;
    const relay = new RelayServer();
    const started = await relay.start(port);
    console.error(`ACEP Relay listening on ${started.url}`);
    return;
  }

  await startMcpServer();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: `README.md` を作成する（MCP登録例と使い方）**

```markdown
# agent-tunnel (ACEP / MCP Bridge)

OpenCode, Codex CLI, Gemini CLI, Antigravity などのエージェントセッション同士を繋ぎ、過不足ないコンテキストだけを構造化して対話・引き継ぎするための MCP ブリッジです。

## ビルド・テスト

\`\`\`bash
npm install
npm run build
npm test
\`\`\`

## MCPサーバーとしての登録例

\`\`\`json
{
  "mcpServers": {
    "agent-tunnel": {
      "command": "node",
      "args": ["/path/to/acep-agent-tunnel/dist/index.js"]
    }
  }
}
\`\`\`

## 外部公開用リレーの起動（任意）

\`\`\`bash
node dist/index.js relay --port 8765
\`\`\`
```

- [ ] **Step 4: 型チェック・ビルド・全テストを実行する**

Run: `npm run typecheck && npm run build && npm test`
Expected: 0 errors, build succeeds, all tests pass

- [ ] **Step 5: コミットする**

```bash
git add src/mcp/server.ts src/index.ts README.md
git commit -m "feat: add MCP server entrypoint, relay CLI, and README"
```
