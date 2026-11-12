# RE/LAY — YouTube 中継プレイヤー

YouTube の URL を入れると、**動画・音声・サムネイルのすべてをこのサーバー経由で中継**して再生するサイトです。
iframe 埋め込みは使わず、ブラウザは YouTube / googlevideo.com に一切接続しません（Invidious / Piped と同じ方式）。

## 仕組み

```
ブラウザ ──/api/info──▶ サーバー ──yt-dlp──▶ YouTube（ストリーム URL を解決）
ブラウザ ──/stream/:id/:format (Range)──▶ サーバー ──10MB ずつ Range 取得──▶ googlevideo.com
ブラウザ ──/thumb/:id──▶ サーバー ──▶ i.ytimg.com
```

- **シーク対応**：ブラウザからの `Range` リクエストをそのまま上流に中継（206 Partial Content）
- **高画質対応**：YouTube は 720p 以上を「映像のみ」「音声のみ」に分けて配信しているため、`<video>` と `<audio>` を JS で同期再生（再生/停止/シーク/速度/音量を連動し、0.25 秒以上ずれたら補正）
- **速度制限の回避**：上流へは 10MB ずつ分割して取得（一括で取ると YouTube 側で絞られるため）
- **URL 失効への対処**：解決結果は 1 時間キャッシュし、上流が 403 を返したら自動で再解決して 1 回だけ再試行
- **SSRF 対策**：クライアントは「動画 ID + フォーマット ID」しか渡せず、任意の URL を中継させることはできない
- `/watch?v=ID`、`/ID`、`/shorts/ID` の URL で直接開いても自動で再生（YouTube の URL のドメイン部分を置き換えるだけで使えます）

## 必要なもの

- Node.js 18 以上
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)（`pip install -U yt-dlp` や `brew install yt-dlp`）
- yt-dlp が YouTube の解析に使う JS ランタイム（[Deno](https://deno.com/) 推奨。yt-dlp の README の指示に従ってください）

## 起動

```bash
npm install
npm start
# → http://localhost:3000
```

### 環境変数

| 変数 | 説明 | 既定値 |
|---|---|---|
| `PORT` | 待ち受けポート | `3000` |
| `YTDLP_PATH` | yt-dlp 実行ファイルのパス | `yt-dlp` |
| `YTDLP_ARGS` | yt-dlp に追加で渡す引数（例：`--cookies cookies.txt`） | なし |

## 運用のヒント

- **yt-dlp はこまめに更新**してください。YouTube 側の変更で解析が壊れることがよくあり、ほとんどは `yt-dlp -U` で直ります。
- **ストリーム URL はサーバーの IP に紐づく**ので、解決と中継は必ず同じサーバーで行う構成にしています（ロードバランサで複数台に分ける場合は注意）。
- **データセンターの IP（VPS / クラウド）は YouTube にブロックされやすい**です。「Sign in to confirm you're not a bot」と出る場合は、自宅回線で動かすか `YTDLP_ARGS="--cookies cookies.txt"` を使ってください。
- 中継した分の帯域はすべてサーバーにかかります（1080p で 1 時間あたり約 1〜2GB）。公開する場合はアクセス制限（Basic 認証など）をおすすめします。
- ライブ配信は非対応です。

## 注意

YouTube の利用規約は、公式プレイヤー以外での再生や、広告を表示しない視聴を認めていません。個人での利用・学習目的にとどめ、不特定多数への公開や、権利者の許可がない動画の再配布は避けてください。
