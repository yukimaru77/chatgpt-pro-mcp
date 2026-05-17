# chatgpt-pro-mcp

MCPクライアント（Claude Code / Claude Desktop / 任意のMCPホスト）から、ログイン済みのCamoufoxブラウザ経由で **ChatGPT Pro** に質問できるMCPサーバーです。ブラウザ操作は Camoufox Browser API を利用します。

各呼び出しごとに新しいChatGPTタブを開き、Proモデルを選択し、指定されたツール（**ウェブ検索** または **Deep Research**）を有効化し、プロンプトを送信し、回答を待って、タブを閉じ、テキストを返します。複数の同時呼び出しはそれぞれ別のタブで動作するため、サブエージェントが並列に作業を展開できます。

> ## ⚠️ 重要: Claude Code のバージョン制限
>
> **サブエージェント（Agentツール）から `deep_researcher` を呼ぶ場合、現在は Claude Code `v2.1.112` 以下が必須です。**
>
> v2.1.113 で「サブエージェントが10分無出力ならkill」というwatchdogがハードコードで導入されており、環境変数や設定では無効化できません。Deep Research は通常1〜2.5時間ほどかかるため、このwatchdogがサブエージェントを先に殺してしまいます。
>
> ダウングレード:
>
> ```bash
> curl -fsSL https://claude.ai/install.sh | bash -s 2.1.112
> ```
>
> 自動アップデートを止めるには `~/.claude/settings.json` に以下を追加:
>
> ```json
> { "env": { "DISABLE_AUTOUPDATER": "1" } }
> ```
>
> 以下のケースではこの制限は適用されません:
> - `deep_thinker` のみ使う場合（通常10〜25分ほどで完了）
> - メインセッションやテストスクリプトから直接 `deep_researcher` を呼ぶ場合

## 提供ツール

| ツール | 用途 | Composerツール | デフォルトタイムアウト |
|---|---|---|---|
| `deep_thinker` | 最新のWebコンテキストを踏まえた非常に高性能な高度推論。結果まで通常10〜25分ほどかかります。 | ウェブ検索 | 120分 |
| `deep_researcher` | 複数ソースを横断する非常に高性能な調査 / レポート出力。結果まで通常1〜2.5時間ほどかかります。 | Deep Research | 120分 |
| `server_status` | このMCPサーバープロセスのスロット使用状況 / 待機中 / 実行中 / 直近完了・エラーを確認 | なし | 即時 |

どちらも `model` を省略すると `chatgpt-mcp.yaml` の `defaults.model`（初期値は `pro`）を使います:

```json
{ "prompt": "...", "model": "pro" }
```

`deep_thinker` では `model: "thinking"` を指定できます:

```json
{ "prompt": "...", "model": "thinking" }
```

`server_status` は引数なしで現在状態を返します。直近完了・エラーの件数だけ変える場合は `completedLimit` を指定します:

```json
{ "completedLimit": 10 }
```

`test_delayed_response` は実送信せず、指定秒数だけ `polling` 状態を作るためのテスト用です。通常起動ではツール一覧に出ません。テスト時だけサーバーを以下のどちらかで起動してください:

```bash
node dist/index.js --enable-test-tools
CHATGPT_MCP_ENABLE_TEST_TOOLS=1 node dist/index.js
```

```json
{
  "prompt": "これは送信しないテストです",
  "model": "thinking",
  "mode": "web-search",
  "delaySeconds": 60,
  "responseText": "テスト完了"
}
```

## 動作確認環境

以下の環境で動作確認しています。他の環境でも動く可能性はありますが未検証です。

- **Linux**（Camoufox Browser API が起動済みの環境）
- **Node.js 18以上**
- **Camoufox** — Browser API サーバーが起動済みで、**ChatGPT Proに既にログインした状態**

DockerfileやCDP設定は不要です。サーバーは Camoufox Browser API に接続し、既存のCamoufoxプロファイルとChatGPTセッションCookieを利用します。既定の接続先は `http://127.0.0.1:9377`、ユーザーIDは `default` です。

## インストール

```bash
git clone <this repo>
cd chatgpt-pro-mcp
npm install
npm run build
```

## 常駐HTTPサーバーとして起動

複数のCodex / Claude Codeセッションから同じ並列制限を共有したい場合は、stdioではなく常駐HTTPサーバーとして1プロセスだけ起動します:

```bash
npm run build
setsid -f node /absolute/path/to/chatgpt-pro-mcp/dist/index.js --http --port 3333 \
  > /tmp/chatgpt-mcp-http.out 2>&1 < /dev/null
```

疎通確認:

```bash
curl http://127.0.0.1:3333/health
```

Codexへの登録:

```bash
codex mcp add chatgpt --url http://127.0.0.1:3333/mcp
```

Claude Codeへの登録:

```bash
claude mcp add --transport http chatgpt http://127.0.0.1:3333/mcp
```

この形なら `thinking` / `pro` / `deep_research` の並列制限、setup pause、`server_status` は全クライアントで同じ常駐プロセス内の状態を見ます。

## stdioとして登録

stdio登録も可能ですが、クライアントやセッションごとに別プロセスが起動するため、並列制限はプロセスごとのローカル制限になります。

`claude_desktop_config.json`（またはClaude Code相当の設定ファイル）に以下を追加します:

```json
{
  "mcpServers": {
    "chatgpt": {
      "command": "node",
      "args": ["/absolute/path/to/chatgpt-pro-mcp/dist/index.js"]
    }
  }
}
```

クライアントを再起動（または `/mcp` で再接続）すると、ツール一覧に `deep_thinker` と `deep_researcher` が表示されます。

## YAML設定

リポジトリ直下の `chatgpt-mcp.yaml` でデフォルトモデルと並列数を設定します。サーバーは起動時に以下の順で設定ファイルを探します:

1. サーバープロセスのカレントディレクトリの `chatgpt-mcp.yaml`
2. `dist/index.js` と同じディレクトリの `chatgpt-mcp.yaml`
3. `dist/index.js` の1つ上の `chatgpt-mcp.yaml`

```yaml
defaults:
  model: pro

parallelLimits:
  thinking: 5
  pro: 3
  deep_research: 3
```

並列数は「ChatGPTタブを開いて送信済み、かつポーリング中」のリクエスト数です。スロットが空くまではタブを開かず、MCP呼び出し内でFIFO待機します。

- `deep_thinker` + `model: "thinking"` は `thinking` スロットを使います。
- `deep_thinker` + `model: "pro"` は `pro` スロットを使います。
- `deep_researcher` は指定モデルに関係なく `deep_research` スロットを使います。

## 呼び出しの流れ

1. クライアントが `deep_thinker` または `deep_researcher` にプロンプトを付けて呼び出します。
2. モデル / ツール種別に応じた並列スロットを取得します。満杯ならここで待機します。
3. サーバー内部のミューテックスを取得します（他の同時リクエストとセットアップが交錯しないように）。
4. 新しいChatGPTタブを開き、プロモダイアログがあれば閉じ、モデル切替メニューから指定モデルを選び、該当するComposerチップ（ウェブ検索 / Deep Research）をオンにします。
5. プロンプトを入力して送信ボタンをクリックし、会話URL（`/c/<id>`）が確定するのを待ちます。このURLが以降このリクエストのタブを一意に識別します。
6. ミューテックスを解放し、リクエストは自身のポーリングループへ移行します（URLをキーとして管理）。
7. ポーリング（各反復もミューテックス越しに）で2秒ごとにページ状態を取得し、完了（`good-response-turn-action-button` が表示されており、assistantメッセージに thinking/streaming クラスが付いていない状態）を検知したらテキストを抽出してタブを閉じます。
8. 並列スロットを解放し、サーバーがテキストをMCPクライアントに返します。

複数の同時リクエストは同じCamoufoxセッションを共有します。セットアップのみ直列化されるため、各リクエストは「現在のタブ」状態を取り合うことなく自分のタブに着地します。ポーリングと生成はリクエスト間で並列に実行されます。

## クライアント側のタイムアウト設定（Deep Research利用時は重要）

`deep_thinker` は通常10〜25分ほど、`deep_researcher` は通常1〜2.5時間ほどかかります。どちらも非常に高性能な推論・調査を行います。デフォルトではClaude Codeが長時間のMCP呼び出しを強制終了し、サブエージェントも返答前に停止されてしまいます。完了まで待たせるには `~/.claude/settings.json` に以下を追加してください:

```json
{
  "env": {
    "CLAUDE_STREAM_IDLE_TIMEOUT_MS": "86400000",
    "MCP_TIMEOUT": "86400000",
    "MCP_TOOL_TIMEOUT": "86400000"
  }
}
```

（24時間をミリ秒で指定。余裕を持った値です。）変更後はClaude Codeを再起動してください。

| 環境変数 | 用途 | デフォルト |
|---|---|---|
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | サブエージェントが無出力で許容される時間。これを上げないと `deep_researcher` を呼ぶサブエージェントは10分時点で停止します。 | 5分 |
| `MCP_TIMEOUT` / `MCP_TOOL_TIMEOUT` | MCPクライアントがツール応答を待つ上限。stdioトランスポートではこの値が効きます（HTTP-SSEトランスポートには既知の上流バグがあり無視されます — [claude-code#20335](https://github.com/anthropics/claude-code/issues/20335) 参照）。 | 約5分 |

サブエージェントの総実行時間には別途の上限はありません。Claude Codeのバージョン制限については[冒頭の注意書き](#-重要-claude-code-のバージョン制限)を参照してください。

## 会話ログ

成功した呼び出しはすべてカレントディレクトリ配下にアーカイブされます:

```
chatgpt_log/
  deep_thinker/
    20260423123000/
      input.md          # 送信したプロンプト
      output.md         # 応答本文（図への参照があれば含む）
      figures/          # 応答から抽出したSVGなどの図
        fig1.svg
        fig2.svg
  deep_researcher/
    20260423123045/
      ...
```

- ディレクトリ名はローカル時刻の `YYYYMMDDhhmmss` です。同一秒に2件着地した場合は2件目以降に `..._1`, `..._2` … が付与されます。
- `figures/` はコンテンツサイズの図が応答に含まれる場合のみ作成されます。実際にページ上でレンダリングされたものが保存されます:
  - **SVG** → `figN.svg` としてouterHTMLをそのまま保存。
  - **`<img>`** → `src` をバイト列に解決して保存。リモートURLはフェッチ、`data:` URIはBase64デコード。拡張子はURLまたは `Content-Type` から推定（`png`/`jpg`/`gif`/`webp` など）。リモート取得に失敗した場合は `output.md` のリンクは元のURLへフォールバックします。
  - **`<canvas>`** → `toDataURL('image/png')` でエクスポートし `figN.png` として保存。
  - アイコンサイズの小さな画像（16×16のSVGアイコンや50px未満の `<img>` など）は除外されます。
- `output.md` 末尾には `## Figures` セクションが追加され、保存先（または取得失敗時は元のリモートURL）へのMarkdown画像リンクが入ります。相対パスを解決できるMarkdownビューアで開くとインライン表示できます。

`chatgpt_log/` の配置先は以下の優先順で決まります:

1. `CHATGPT_MCP_CONV_LOG_DIR` が絶対パスで指定されていれば、その値をそのまま使用。
2. そうでない場合、相対パス（デフォルトは `chatgpt_log`）を、Claude Codeがセッションごとに注入する `$CLAUDE_PROJECT_DIR` に対して解決。
3. それもなければ、MCPサーバーサブプロセスの `process.cwd()` を基準とする。

結果として、Claude Codeから実行した場合は自動的に現在のセッションのプロジェクトディレクトリ配下にログが集約されます。解決後のパスはサーバー起動時に `/tmp/chatgpt-mcp.log` に `conv_log_root=...` として記録されます。

## サーバー側環境変数

| 変数 | デフォルト | 備考 |
|---|---|---|
| `CHATGPT_MCP_LOG` | `/tmp/chatgpt-mcp.log` | サーバーが構造化ログを書き出すファイル。 |
| `CHATGPT_MCP_VERBOSE` | 未設定 | `1` に設定するとポーリングごとの追加トレースが出力されます。 |
| `CHATGPT_MCP_CAMOFOX_URL` | `http://127.0.0.1:9377` | Camoufox Browser API の接続先。 |
| `CHATGPT_MCP_CAMOFOX_USER_ID` | `default` | CamoufoxのユーザーID。 |
| `CHATGPT_MCP_CAMOFOX_SESSION_KEY` | `default` | Camoufoxのセッションキー。 |
| `CHATGPT_MCP_CAMOFOX_API_KEY` | 未設定 | Camoufox APIキー。未設定時は `/home/yukimaru/camofox-mcp/.env` の `CAMOFOX_API_KEY` を読みます。 |
| `CHATGPT_MCP_THINKER_MAX_MIN` | `120` | `deep_thinker` のタイムアウト（分）。 |
| `CHATGPT_MCP_RESEARCHER_MAX_MIN` | `120` | `deep_researcher` のタイムアウト（分）。 |
| `CHATGPT_MCP_CONV_LOG_DIR` | `chatgpt_log` | 会話ログのルートディレクトリ。相対パスはサーバーのcwdを基準に解決。 |

## ローカルテスト

```bash
# 単発スモークテスト（デフォルトで deep_thinker を使用）
node scripts/mcp_test.mjs "富士山の高さは？10字で。"

# 並列スモーク（3プロンプト / deep_thinker）:
node scripts/mcp_test.mjs "日本の首都は？" "フランス革命は何年？" "光合成とは？"

# 環境変数でツール切替:
MCP_TOOL=deep_researcher node scripts/mcp_test.mjs "3DGS研究の現状を調査して。"

# モデル切替:
MCP_MODEL=thinking node scripts/mcp_test.mjs "短く自己紹介して。"
```

別ターミナルで `tail -f /tmp/chatgpt-mcp.log` を流しておくと動作を追えます。

## 既知の制約

- **Camoufox 1セッション前提**。同じCamoufoxユーザーを操作するMCPサーバープロセスが同時に複数存在するとタブ状態で競合します。1つのサーバーに対して1つのClaude Codeセッション内から複数MCPクライアントが繋がるのは問題ありません。
- **ChatGPT UIの変化**。セレクタ（`data-testid="send-button"`、`menuitemradio "ウェブ検索"` / `"Deep research"`、チップのaria-label）は変わり得ます。セットアップで失敗するときはログを確認してください — 最も多い症状はチップの検証タイムアウトです。
- **モデル依存の所要時間**。`deep_thinker` は通常10〜25分ほど、`deep_researcher` は通常1〜2.5時間ほどかかります。非常に高性能な推論・調査を行います。必要に応じてタイムアウト環境変数を調整してください。
