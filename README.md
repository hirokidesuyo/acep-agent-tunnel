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

## 外部公開用リレーの起動（任意）

```bash
node dist/index.js relay --port 8765
```
