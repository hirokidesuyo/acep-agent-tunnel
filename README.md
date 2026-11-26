# acep-agent-tunnel (ACEP / MCP Bridge)

OpenCode、Codex CLI、Gemini CLI、Claude Code、Antigravity、GitHub Copilot などの **AIエージェントの「生きているセッション」同士を繋ぎ、過不足ないコンテキストだけを構造化して対話・引き継ぎする** ための MCP サーバー＆プロトコル（ACEP: Agent Context Exchange Protocol）実装です。

## 何ができるのか？

1. **同一マシン・個人間でのセッション引き継ぎ（`trusted` モード）**
   - 例：Codex CLI で進めていた作業を、別のエージェント（Gemini CLI や Antigravity 等）へ「どこまで終わったか・変更したファイル・ハマりポイント」を会話して引き継ぐ。
2. **別マシン・SNS 越しの安全相談（`public` モード ＋ `acep+nostr://`）**
   - **例**：SNS で「この OSS のローカル構築が動いた！」と投稿した人（ホスト）に、環境構築で詰まった人（シーカー）がリプライや DM で相談を持ちかけます。ホストは自分のエージェントでワンタイムの接続 URI を発行して DM で共有。あとは双方のエージェント同士が `QUERY` ⇄ `NEED_INFO` ⇄ `ANSWER` で環境差異を自動で突き止め、解決策を提示します（※1つの URI は先着1名の 1対1 接続にロックされます）。

```text
[Agent A (Host)] ──(MCP)──▶ [agent-tunnel] ──(Nostr NIP-44 / WebSocket / Cloudflared)──▶ [agent-tunnel] ◀──(MCP)── [Agent B (Seeker)]
```

---

## セットアップ

Node.js 20+ が必要です。

```bash
git clone https://github.com/hirokidesuyo/acep-agent-tunnel.git
cd acep-agent-tunnel
npm install
npm run build
npm test
```

### MCP サーバーとしての登録例

お使いの MCP 対応エージェント設定ファイルに以下を追加してください。

```json
{
  "mcpServers": {
    "agent-tunnel": {
      "command": "node",
      "args": ["/path/to/acep-agent-tunnel/dist/index.js"]
    }
  }
}
```

---

## 使い方（エージェントへの指示例）

### パターン1：Nostr 経由で別マシン・他者と安全に繋ぐ（推奨・穴あけ不要）

* **ホスト側（教える側）の指示例**：
  > 「今の作業内容を共有したいから、Nostr 経由で他人向けの公開チャネル（public）を開いて接続 URI を教えて。そのあと相手からの質問を待機して答えて。」
  - （パラメータ名を明示したい場合：`open_channel` を `transport: "nostr"`, `trust_mode: "public"` で開き、`wait_for_peer` で待機）
  - `acep+nostr://<pubkey>/<channel_id>?token=...` 形式の URI が発行されます。
  - 通信はセッションごとの使い捨て鍵ペア＋ **NIP-44 E2E 暗号化**＋リレー非保存の一時イベント（Kind `21337`）で行われ、`HANDSHAKE` 内の招待トークンが一致しない相手は拒否されます。

* **シーカー側（聞く側）の指示例**：
  > 「この URI に繋いで、自分の環境でビルドが通らない原因を聞いてみて。必要な情報を聞かれたら調べて答えて。」

※ メインのチャット画面を止めたくない場合は、**サブエージェント** に作業サマリーを渡して `wait_for_peer` ループを任せることもできます。

### パターン2：同一マシン内の別ツールへ引き継ぐ

* ホスト側で `open_channel` を `trust_mode: "trusted"`（`transport` 省略でローカル WebSocket リレー自動起動）で開き、出てきた `acep://127.0.0.1:...` を別ツールのセッションへ渡して `connect_channel` します。

---

## 提供される MCP ツール（5つ）

| ツール名 | 役割 |
| :--- | :--- |
| `open_channel` | 相談用チャネルを開設し、共有可能な `connect_uri` を発行する |
| `wait_for_peer` | 相手からの ACEP メッセージ（`HANDSHAKE` / `QUERY` 等）を待機して受け取る |
| `reply_to_peer` | `NEED_INFO`（不足情報の逆質問）/ `ANSWER`（回答）/ `CLOSE` を返信する |
| `connect_channel` | `connect_uri`（`acep://`, `aceps://`, `acep+nostr://`）へ接続し `HANDSHAKE` を送る |
| `ask_peer` | ホストへ `QUERY` または `CLOSE` を送り、応答を待機する |

---

## セキュリティ境界（`trusted` vs `public`）

* **`trusted`（自分用・引き継ぎ向け）**: ローカルパスや設定内容をそのまま送受信します。
* **`public`（他者共有向け）**:
  - 送信前にサニタイザが自動で走り、API キー（`sk-...`, `ghp_...`, `AIza...` 等）、`Bearer` トークン、秘密鍵ブロック、およびホームディレクトリの絶対パス（`/Users/<name>/...`, `C:\Users\<name>\...` → `~/...`）を自動マスクします（オブジェクトのキーも対象）。
  - Nostr トランスポート利用時の 1 メッセージ上限は NIP-44 仕様により **65,535 bytes**（UTF-8）です。

---

## 環境変数・その他の公開手段

| 環境変数 / オプション | 説明 |
| :--- | :--- |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY` | WebSocket リレーおよび Nostr リレーへの接続時に HTTP `CONNECT` プロキシを自動利用します（`127.0.0.1` / `localhost` / `::1` は自動バイパス）。 |
| `expose_public: true`（`open_channel` 引数） | ローカルに `cloudflared` が導入されていれば Quick Tunnel（`aceps://*.trycloudflare.com/...`）を自動起動します。 |
| `ACEP_CLOUDFLARED_PROTOCOL` | `cloudflared` の通信プロトコルを指定します（`auto` / `quic` / `http2`）。QUIC が通らない環境では `http2` が有効です。 |
| `ACEP_CLOUDFLARED_LOG_FILE` | `cloudflared` の標準出力・標準エラー出力を追記保存するログファイルパスを指定します。 |

### 外部公開用リレーの単独起動（任意）

VPS 等で独自に WebSocket リレーを立てる場合は以下で起動できます。

```bash
node dist/index.js relay --port 8765
```
