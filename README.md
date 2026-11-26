# agent-tunnel (ACEP / MCP Bridge)

OpenCode, Codex CLI, Gemini CLI, Antigravity などのエージェントセッション同士を繋ぎ、過不足ないコンテキストだけを構造化して対話・引き継ぎするための MCP ブリッジです。

## ビルド・テスト

```bash
npm install
npm run build
npm test
```

## MCPサーバーとしての登録例

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

## 提供される MCP ツール

- `open_channel`: 相談用チャネルを開設し、共有可能な `connect_uri` を発行する
- `wait_for_peer`: 接続先ピアからの ACEP メッセージ受信を待機する
- `reply_to_peer`: ピアへ `NEED_INFO` / `ANSWER` / `CLOSE` を返信する
- `connect_channel`: `connect_uri` を指定してホストのチャネルに接続する
- `ask_peer`: ホストへ `QUERY` または `CLOSE` を送信し、応答を待機する

## 外部公開（Nostr / cloudflared Quick Tunnel / リレー単独起動）

VM やインターネット越しに公開する場合は、以下のいずれかを利用できます。

1. **Nostr トランスポート（`acep+nostr://`、穴あけ不要・E2E暗号化）**
   - `open_channel` で `transport: "nostr"` を指定すると、セッションごとの使い捨て鍵ペアと NIP-44 暗号化を用いた `acep+nostr://...` URI を発行します（デフォルトは公開リレー、または `nostr_relays` で指定）。
2. **`cloudflared` 自動連携（アカウント不要）**
   - ホスト側マシンに `cloudflared` をインストールした状態で、`open_channel` 呼び出し時に `expose_public: true` を指定すると、自動で `aceps://*.trycloudflare.com/...` 形式の公開接続URIを発行します。
   - QUIC が通らないネットワークでは環境変数 `ACEP_CLOUDFLARED_PROTOCOL=http2` を設定できます。また `ACEP_CLOUDFLARED_LOG_FILE=/tmp/cloudflared.log` でトンネルのログをファイルに保存できます。
3. **外部公開用リレーの単独起動**
```bash
node dist/index.js relay --port 8765
```
