# LINE Neon Discord Bot 
*AI生成です　使用する場合は自己責任でお願いします

Node.js + LINE Messaging API + Neon PostgreSQL + OpenRouter + Discord Webhook。

## 自動圧縮

LINEから画像・動画を受信すると、まず元ファイルをDiscordへ送信します。
Discordへ送れないサイズの場合は自動圧縮します。

### 画像

Sharpを使用してJPEG/WebPへ変換し、長辺を縮小しながら品質を下げてDiscord目標サイズ以下を目指します。

### 動画

FFmpegを使用してMP4/H.264/AACへ変換します。
ビットレートと解像度を段階的に下げ、Discord目標サイズ以下を目指します。

### 注意

圧縮してもDiscord目標サイズ以下にならない非常に長い動画は送信できない場合があります。
その場合はDiscordへ失敗通知を送ります。

## Koyeb

GitHubからDeployする場合はBuildpackでOKです。

Start command:
npm start

Webhook:
https://YOURDOMAIN/webhook

## 必要な環境変数

`.env.example`を参考にKoyebのEnvironment Variablesへ設定してください。

特に以下は必須です。

- LINE_CHANNEL_ACCESS_TOKEN
- LINE_CHANNEL_SECRET
- DATABASE_URL
- OPENROUTER_API_KEY
- DISCORD_WEBHOOK_URL
- WEATHER_AREA_CODE
- ADMIN_IDS

## 管理者追加

管理者本人が:

`/adminplususer Uxxxxxxxx`

で追加できます。

最初の管理者はADMIN_IDSに入れてください。
