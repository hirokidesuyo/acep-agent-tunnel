# Agent Context Exchange Protocol (ACEP) & MCPブリッジ 設計書

- **作成日**: 2026-11-26
- **ステータス**: レビュー待ち（Draft）
- **対象プロジェクト**: `agent-tunnel`

---

## 1. 背景と目的

LLMエージェント（OpenCode, Codex CLI, Gemini CLI, Claude Code, Antigravity など）が日常的に開発や環境構築を行う時代において、**「お互いのローカル環境や試行錯誤の文脈を把握していないエージェント同士（または人間同士）が、過不足ない情報だけを柔軟に通信して問題を解決する」** ための仕組みが必要とされている。

本プロジェクトは、既存の各種エージェントセッションからそのまま利用できる **「一発トンネル ＋ LLM間コンテキストネゴシエーション・プロトコル」** を提供する。

### 主要ユースケース

1. **個人間・ツール間のタスク引き継ぎ（`trusted` モード）**
   - 例：Codex CLI で進めていた作業を、同一PC内（または別端末）の Gemini CLI や Antigravity に引き継ぎたいとき。「あのファイルどこに置いた？」「テストが落ちている箇所はどこ？」といった文脈を、セッション間で直接対話して引き継ぐ。
2. **SNS等での他者との環境・ノウハウ共有（`public` モード）**
   - 例：Aさんが「Gemma 100 tok/s 出た！」とSNSに投稿し、同じリソースで 50 tok/s しか出ないBさんが「どうやったんですか？」と質問した場面。
   - Aさんは自分のセッションから相談窓口リンクを発行してリプ欄に貼り、Bさんは自分のエージェントセッションからそのリンクに接続する。双方のAIが「今足りない環境差分・設定値」だけを自動で聞き出し合い、解決策を導く。

---

## 2. 全体アーキテクチャ

システムは以下の **3つの独立したコンポーネント** で構成する。

```text
[Agent A (OpenCode / Codex 等)]              [Agent B (Gemini / OpenCode 等)]
  │  (親セッション or サブエージェント)           │
  ▼                                            ▼
[MCP Server (agent-tunnel)]                  [MCP Server (agent-tunnel)]
  │  ツール: open_channel / wait / reply         │  ツール: connect / ask_peer
  └───────────────┐                  ┌─────────┘
                  ▼                  ▼
        [WebSocket リレー / トンネル層]
         - ローカル通信 (localhost / IPC)
         - インターネット越し (Cloudflare Tunnel / 外部リレー)
```

1. **MCPブリッジ (`mcp-server`)**
   - 各種エージェントが共通してサポートする Model Context Protocol (MCP) サーバーとして動作。
   - エージェントが持つ「現在進行中の会話文脈」と「ローカル環境へのアクセス能力」を活かしたまま通信できる。
2. **対話プロトコル (`protocol`: ACEP)**
   - 自然言語の冗長なやり取りを避け、目的・既知の前提・不足情報（スロット）を構造化してやり取りする JSON ベースのプロトコル。
3. **トランスポート／リレー層 (`relay`)**
   - チャネルIDとワンタイムトークンによる一時的なセッション空間を管理し、双方のメッセージを中継する軽量 WebSocket サーバー。

---

## 3. セッションの待機・応答モデル

エージェントは通常「ユーザー入力をトリガーに動作する」ため、教える側（Aさん）の応答には以下の2通りの運用を同じMCPツール群で実現する。

1. **親セッション直結待機**
   - Aさんが現在のセッション内で `open_channel` → `wait_for_peer` を呼び出す。
   - 相手から質問が来ると `wait_for_peer` の戻り値として質問が返り、これまでの文脈を100%保持したAさんのAIが `reply_to_peer` で回答する。
   - 個人間のタスク引き継ぎ（Codex → Gemini 等）に最適。
2. **サブエージェント待機**
   - 親セッションが「これまでの作業サマリー・関連ファイルパス・注意事項」をサブエージェントに渡し、バックグラウンドで `wait_for_peer` ループを実行させる。
   - Aさんのメイン画面をブロックせず、追加のAPIキー設定も不要でリアルタイム応答が可能。

---

## 4. 対話プロトコル仕様 (ACEP)

### 4.1 共通メッセージエンベロープ

すべてのメッセージは以下の JSON 構造を持つ。

```json
{
  "protocol": "acep/1.0",
  "channel_id": "ch_9f8e7d6c",
  "message_id": "msg_001",
  "reply_to": null,
  "sender_role": "seeker",
  "type": "QUERY",
  "timestamp": "2026-11-26T22:25:00+09:00",
  "payload": {}
}
```

### 4.2 メッセージ種別と対話フロー

| 種別 (`type`) | 送信側 | 役割と主要フィールド (`payload`) |
| :--- | :--- | :--- |
| `HANDSHAKE` | 双方 | 接続確立とポリシー合意。`purpose`（目的）、`trust_mode`（`trusted` / `public`）、`capabilities`（対応機能）を交換する。 |
| `QUERY` | 質問側 (`seeker`) | 質問と現在の前提を送信。`question`（自然言語の要約）、`context_slots`（既知の環境値 K-V）、`requested_slots`（知りたい項目キー配列）。 |
| `NEED_INFO` | 応答側 (`host`) | 回答に必要な不足情報のみを逆質問。`reason`（なぜ必要か）、`requested_slots`（追加で教えてほしい項目キー配列）。 |
| `ANSWER` | 応答側 (`host`) | 解決策や引き継ぎ内容を返却。`summary`（回答要約）、`provided_slots`（設定値・コマンド等の構造化データ）、`verification_steps`（確認手順）。 |
| `CLOSE` | 双方 | 対話の終了通知。`reason`（`resolved` / `timeout` / `cancelled`）。 |

### 4.3 過不足ない情報交換の流れ（例）

1. B（`seeker`）→ `CONNECT` / `HANDSHAKE`
2. B → `QUERY`: `{ question: "Gemmaが50tok/sしか出ない", context_slots: { gpu: "RTX4090", backend: "llama.cpp" }, requested_slots: ["quantization", "launch_args"] }`
3. A（`host`）→ `NEED_INFO`: `{ reason: "バックエンドのビルド設定とCUDA状況の切り分けが必要", requested_slots: ["cuda_version", "flash_attention"] }`
4. B → `QUERY` (`reply_to` 指定): `{ context_slots: { cuda_version: "12.4", flash_attention: false } }`
5. A → `ANSWER`: `{ summary: "Flash Attentionを有効化してください", provided_slots: { launch_args: "--flash-attn" }, verification_steps: ["再起動してtok/sを確認"] }`
6. B → `CLOSE`: `{ reason: "resolved" }`

---

## 5. 信頼レベルとセキュリティ境界

チャネル開設時（`open_channel`）に `trust_mode` を必須指定する。

* **`trusted`（個人間・引き継ぎ用）**
  - ローカルの絶対パス、リポジトリ構造、設定ファイル内容、環境情報などを制限なく共有可能。
* **`public`（SNS・他人向け公開用）**
  - **MCPサーバー側の強制フィルタ**: 送信前に正規表現およびヒューリスティック検査を行い、APIキー・アクセストークン（`sk-...`, `ghp_...`, `AIza...` 等）、Authorizationヘッダ、秘密鍵ブロック（`-----BEGIN ... PRIVATE KEY-----`）、ユーザーホームディレクトリの絶対パス（`/Users/<name>/` → `~/` へ置換）を自動的にマスク・サニタイズする。
  - **AIプロンプト側の制約**: `HANDSHAKE` およびツール説明により、非公開ソースコードや個人情報を開示しないよう指示する。

---

## 6. MCPツールインターフェース

MCPサーバーは以下の **5つのツール** を提供する。

1. `open_channel`
   - **引数**: `purpose` (string), `trust_mode` (`"trusted" | "public"`), `context_summary` (string), `relay_url` (optional string)
   - **戻り値**: `channel_id`, `join_token`, `connect_uri`（例: `acep://localhost:8765/ch_xxx?token=yyy`）
2. `wait_for_peer`
   - **引数**: `channel_id` (string), `timeout_sec` (number, default: 120)
   - **戻り値**: 受信した相手の `ACEPMessage`（タイムアウト時は待機継続を促すステータスを返す）
3. `reply_to_peer`
   - **引数**: `channel_id` (string), `reply_to` (string), `type` (`"NEED_INFO" | "ANSWER" | "CLOSE"`), `content` (object)
   - **戻り値**: 送信確認ステータス（`public` モード時はマスクされた項目があれば警告リストを返す）
4. `connect_channel`
   - **引数**: `connect_uri` (string)
   - **戻り値**: `channel_id`, `host_purpose`, `trust_mode`（`HANDSHAKE` 完了後の接続情報）
5. `ask_peer`
   - **引数**: `channel_id` (string), `type` (`"QUERY" | "CLOSE"`), `question` (string), `context_slots` (object), `requested_slots` (string[]), `timeout_sec` (number, default: 60)
   - **戻り値**: ホスト側から返ってきた `ACEPMessage`（`NEED_INFO` または `ANSWER`）

---

## 7. 技術スタックと開発フェーズ

* **言語・ランタイム**: TypeScript (Node.js 20+)
* **主要ライブラリ**:
  - `@modelcontextprotocol/sdk` (MCPサーバー実装)
  - `ws` (WebSocketリレー＆クライアント)
  - `zod` (プロトコルメッセージおよびツール引数の厳密なバリデーション)
  - `vitest` (ユニット・統合テスト)

### 開発フェーズ

* **Phase 1（コア機能の構築・ローカル完結）**
  - ACEPプロトコル型定義・Zodスキーマ
  - ローカルWebSocketリレーサーバー（`open_channel` 時に未起動なら自動起動も可能にする）
  - 5つのMCPツール実装
  - ユニットテストおよび「2つの擬似エージェントが `QUERY` ⇄ `NEED_INFO` ⇄ `ANSWER` で問題を解決する」統合テスト
* **Phase 2（安全性強化・外部公開対応）**
  - `public` モード用シークレット・個人情報マスキングエンジンの実装とテスト
  - 外部リレーサーバー／トンネル（`cloudflared` 等）連携によるインターネット越しのURL共有対応
