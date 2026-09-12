import "dotenv/config";
import express from "express";
import crypto from "crypto";
import axios from "axios";
import FormData from "form-data";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import os from "os";
import path from "path";
import { promises as fs } from "fs";

import {
  initDb, ensureUser, incrementMessageCount, getUser, isAdmin,
  addAdmin, getAdmins, addCoins, transferCoins, getMessageRank,
  getCoinRank, getMessagePosition, claimLoginBonus, hasRobbedToday,
  robCoins, resetMessageRank, setAiEnabled
} from "./db.js";

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-oss-20b";
const WEATHER_AREA_CODE = process.env.WEATHER_AREA_CODE || "130000";

const TARGET_MB = Number(process.env.DISCORD_MAX_UPLOAD_MB || 9.5);
const TARGET_BYTES = Math.floor(TARGET_MB * 1024 * 1024);
const IMAGE_MAX_DIMENSION = Number(process.env.IMAGE_MAX_DIMENSION || 2560);
const VIDEO_MAX_DIMENSION = Number(process.env.VIDEO_MAX_DIMENSION || 1280);
const VIDEO_MAX_SECONDS = Number(process.env.VIDEO_MAX_SECONDS || 0);

if (!LINE_TOKEN || !LINE_SECRET) console.warn("LINE credentials are missing.");
if (!DISCORD_WEBHOOK_URL) console.warn("DISCORD_WEBHOOK_URL is missing.");

app.get("/", (_req, res) => res.json({ ok: true, service: "LINE Neon Discord Bot" }));

function verifySignature(rawBody, signature) {
  if (!signature || !LINE_SECRET) return false;
  const digest = crypto.createHmac("SHA256", LINE_SECRET).update(rawBody).digest("base64");
  const a = Buffer.from(digest), b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post("/webhook", express.raw({ type: "application/json", limit: "300mb" }), async (req, res) => {
  try {
    if (!verifySignature(req.body, req.headers["x-line-signature"])) return res.status(401).send("invalid signature");
    const body = JSON.parse(req.body.toString("utf8"));
    res.status(200).send("OK");
    for (const event of body.events || []) processEvent(event).catch(err => console.error("event error:", err));
  } catch (err) {
    console.error("webhook error:", err);
    if (!res.headersSent) res.status(400).send("Bad Request");
  }
});

function sourceUserId(event) { return event?.source?.userId || null; }

async function getDisplayName(lineId) {
  try {
    const r = await axios.get(`https://api.line.me/v2/bot/profile/${encodeURIComponent(lineId)}`, {
      headers: { Authorization: `Bearer ${LINE_TOKEN}` }, timeout: 15000
    });
    return r.data.displayName || "Unknown";
  } catch { return "Unknown"; }
}

async function reply(replyToken, text) {
  if (!replyToken) return;
  await axios.post("https://api.line.me/v2/bot/message/reply", {
    replyToken,
    messages: [{ type: "text", text: String(text).slice(0, 5000) }]
  }, { headers: { Authorization: `Bearer ${LINE_TOKEN}`, "Content-Type": "application/json" }, timeout: 30000 });
}

async function lineGetContent(messageId) {
  const r = await axios.get(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_TOKEN}` },
    responseType: "arraybuffer", timeout: 180000,
    maxContentLength: 300 * 1024 * 1024, maxBodyLength: 300 * 1024 * 1024
  });
  return { data: Buffer.from(r.data), contentType: r.headers["content-type"] || "application/octet-stream" };
}

async function lineGetPreview(messageId) {
  try {
    const r = await axios.get(`https://api-data.line.me/v2/bot/message/${messageId}/content/preview`, {
      headers: { Authorization: `Bearer ${LINE_TOKEN}` },
      responseType: "arraybuffer", timeout: 60000, maxContentLength: 20 * 1024 * 1024
    });
    return { data: Buffer.from(r.data), contentType: r.headers["content-type"] || "image/jpeg" };
  } catch { return null; }
}

async function sendDiscordText(content) {
  if (!DISCORD_WEBHOOK_URL) return;
  await axios.post(DISCORD_WEBHOOK_URL, {
    content: String(content).slice(0, 1900),
    allowed_mentions: { parse: [] }
  }, { timeout: 30000 });
}

async function sendDiscordFile(buffer, filename, content, contentType) {
  if (!DISCORD_WEBHOOK_URL) return false;
  if (buffer.length > TARGET_BYTES) return false;

  const form = new FormData();
  form.append("payload_json", JSON.stringify({
    content: String(content).slice(0, 1900),
    allowed_mentions: { parse: [] }
  }));
  form.append("files[0]", buffer, { filename, contentType });

  await axios.post(DISCORD_WEBHOOK_URL, form, {
    headers: form.getHeaders(), timeout: 180000,
    maxContentLength: Infinity, maxBodyLength: Infinity
  });
  return true;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function extForType(contentType, type) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("jpeg")) return ".jpg";
  if (ct.includes("png")) return ".png";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("mp4")) return ".mp4";
  if (ct.includes("quicktime")) return ".mov";
  if (ct.includes("mpeg")) return ".mp3";
  if (ct.includes("pdf")) return ".pdf";
  if (type === "image") return ".jpg";
  if (type === "video") return ".mp4";
  if (type === "audio") return ".mp3";
  return ".bin";
}

async function compressImage(input, outputDir) {
  const qualities = [85, 75, 65, 55, 45, 35, 28, 22];
  const scales = [1, 0.85, 0.7, 0.55, 0.4, 0.3];
  let last = null;

  for (const scale of scales) {
    const width = Math.max(320, Math.floor(IMAGE_MAX_DIMENSION * scale));
    for (const quality of qualities) {
      const output = path.join(outputDir, `image-${Date.now()}-${scale}-${quality}.jpg`);
      await sharp(input)
        .rotate()
        .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toFile(output);

      const stat = await fs.stat(output);
      last = output;
      if (stat.size <= TARGET_BYTES) return { path: output, contentType: "image/jpeg" };
      await fs.unlink(output).catch(() => {});
    }
  }
  return last ? { path: last, contentType: "image/jpeg" } : null;
}

function runFfmpeg(input, output, videoBitrate, audioBitrate, width) {
  return new Promise((resolve, reject) => {
    let command = ffmpeg(input)
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions([
        "-preset veryfast",
        "-movflags +faststart",
        "-pix_fmt yuv420p",
        "-maxrate " + videoBitrate,
        "-bufsize " + (parseInt(videoBitrate, 10) * 2) + "k",
        "-b:a " + audioBitrate
      ])
      .videoFilters(`scale='min(${width},iw)':-2`);

    if (VIDEO_MAX_SECONDS > 0) command = command.duration(VIDEO_MAX_SECONDS);

    command
      .on("end", resolve)
      .on("error", reject)
      .save(output);
  });
}

async function compressVideo(input, outputDir) {
  const profiles = [
    ["1800k", "128k", VIDEO_MAX_DIMENSION],
    ["1400k", "112k", 1280],
    ["1000k", "96k", 960],
    ["750k", "80k", 854],
    ["500k", "64k", 720],
    ["350k", "48k", 640],
    ["250k", "40k", 540],
    ["180k", "32k", 480]
  ];

  let last = null;
  for (const [vb, ab, width] of profiles) {
    const output = path.join(outputDir, `video-${Date.now()}-${vb}.mp4`);
    try {
      await runFfmpeg(input, output, vb, ab, width);
      const stat = await fs.stat(output);
      last = output;
      if (stat.size <= TARGET_BYTES) return { path: output, contentType: "video/mp4" };
    } catch (e) {
      console.error("ffmpeg profile error:", e.message);
    }
  }
  return last ? { path: last, contentType: "video/mp4" } : null;
}

async function logTextToDiscord(name, lineId, text, event) {
  const room = event?.source?.type === "group"
    ? `group:${event.source.groupId}`
    : event?.source?.type === "room"
      ? `room:${event.source.roomId}` : "1:1";

  await sendDiscordText(
    `**LINE会話ログ**\nユーザー: ${name}\nLINE ID: \`${lineId || "unknown"}\`\n場所: ${room}\n内容:\n${text}`
  );
}

async function logMediaToDiscord(name, lineId, event) {
  const messageId = event.message.id;
  const type = event.message.type;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "line-media-"));

  try {
    const original = await lineGetContent(messageId);
    const originalExt = extForType(original.contentType, type);
    const originalPath = path.join(tempDir, `original${originalExt}`);
    await fs.writeFile(originalPath, original.data);

    const description =
      `**LINE会話ログ**\nユーザー: ${name}\nLINE ID: \`${lineId || "unknown"}\`\n` +
      `種類: ${type}\n元サイズ: ${formatBytes(original.data.length)}`;

    // まず元ファイルを送れるならそのまま送る。
    if (original.data.length <= TARGET_BYTES) {
      await sendDiscordFile(original.data, `line-${messageId}${originalExt}`, description, original.contentType);
      return;
    }

    // 大きければ圧縮。
    let compressed = null;
    if (type === "image") {
      compressed = await compressImage(originalPath, tempDir);
    } else if (type === "video") {
      // 動画プレビューを先に送る。
      const preview = await lineGetPreview(messageId);
      if (preview && preview.data.length <= TARGET_BYTES) {
        await sendDiscordFile(
          preview.data, `preview-${messageId}.jpg`,
          `${description}\n🎞️ 動画プレビュー`, preview.contentType
        );
      }
      compressed = await compressVideo(originalPath, tempDir);
    }

    if (compressed) {
      const data = await fs.readFile(compressed.path);
      if (data.length <= TARGET_BYTES) {
        await sendDiscordFile(
          data,
          type === "image" ? `line-${messageId}-compressed.jpg` : `line-${messageId}-compressed.mp4`,
          `${description}\n🗜️ 自動圧縮済み\n圧縮後: ${formatBytes(data.length)}`,
          compressed.contentType
        );
        return;
      }
    }

    await sendDiscordText(
      `${description}\n⚠️ 自動圧縮後もDiscord送信サイズ以下にできませんでした。`
    );
  } catch (err) {
    console.error("media log error:", err);
    await sendDiscordText(
      `**LINE会話ログ**\nユーザー: ${name}\n種類: ${type}\n⚠️ メディアの取得/圧縮/Discord送信に失敗しました。`
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function extractMentionId(event) {
  return (event?.message?.mention?.mentionees || []).find(m => m.userId)?.userId || null;
}

function argsAfterCommand(text) {
  const parts = text.trim().split(/\s+/);
  return { command: parts[0].toLowerCase(), args: parts.slice(1) };
}

function parseAmount(value, currentCoins) {
  if (!value) return null;
  if (value.toLowerCase() === "all") return currentCoins;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function formatRank(rows, field) {
  if (!rows.length) return "まだデータがありません。";
  return rows.map((r, i) => {
    const value = field === "coin" ? Number(r.coins) : Number(r.message_count);
    return `${i + 1}. ${r.display_name} — ${value.toLocaleString()}${field === "coin" ? "coin" : "回"}`;
  }).join("\n");
}

async function openRouterChat(content) {
  if (!OPENROUTER_API_KEY) return "OpenRouter APIキーが設定されていません。";
  const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
    model: OPENROUTER_MODEL,
    messages: [
      { role: "system", content: "あなたはLINE BotのAIアシスタントです。日本語で自然に回答してください。" },
      { role: "user", content }
    ]
  }, {
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://example.com",
      "X-Title": process.env.OPENROUTER_APP_NAME || "LINE Bot"
    },
    timeout: 120000
  });
  return response.data?.choices?.[0]?.message?.content || "AIから回答を取得できませんでした。";
}

async function weather() {
  const response = await axios.get(
    `https://www.jma.go.jp/bosai/forecast/data/forecast/${encodeURIComponent(WEATHER_AREA_CODE)}.json`,
    { timeout: 20000 }
  );
  const data = response.data, office = data?.[0]?.publishingOffice || "気象庁";
  const ts = data?.[0]?.timeSeries?.[0];
  if (!ts) return "天気情報を取得できませんでした。";
  const area = ts.areas?.[0], dates = ts.timeDefines || [];
  const weathers = area?.weathers || [], pops = area?.pops || [];
  const lines = dates.slice(0, 3).map((d, i) =>
    `${d.slice(0, 10)}：${weathers[i] || "不明"}${pops[i] ? ` / 降水確率 ${pops[i]}%` : ""}`
  );
  return `🌤️ ${office}\n地域コード: ${WEATHER_AREA_CODE}\n${lines.join("\n")}`;
}

const omikuzi = [
  ["大吉"],
  ["中吉"],
  ["小吉"],
  ["吉"],
  ["末吉"],
  ["凶"],
  ["大凶"]
];

function drawOmikuzi() {
  const [result, message] = omikuzi[Math.floor(Math.random() * omikuzi.length)];
  return `🥠 おみくじ\n結果：${result}\n${message}`;
}

function helpText() {
  return [
    "📖 コマンド一覧", "",
    "/ai <内容> - AIと会話",
    "/mycoin - コイン数",
    "/rank - 発言回数ランキング",
    "/rank coin - コインランキング",
    "/rankcoin - コインランキング",
    "/myrank - 自分の発言順位",
    "/login - ログインボーナス",
    "/tenki - 天気",
    "/omikuzi - おみくじ",
    "/rob @ユーザー - 1日1回の強盗",
    "/coints <表|裏> <金額|all> - コイントス",
    "/slot <金額|all> - スロット",
    "/pay <金額> @メンション - 送金",
    "",
    "管理者:",
    "/give coin <数> @メンション",
    "/uid @メンション",
    "/admins",
    "/resetrank",
    "/offbot @メンション",
    "/onbot @メンション",
    "/adminplususer <LINE USER ID>"
  ].join("\n");
}

async function handleText(event, lineId) {
  const text = event.message.text.trim();
  const { command, args } = argsAfterCommand(text);

  if (!text.startsWith("/")) return;

  if (command === "/help" || command === "/commands") {
    await reply(event.replyToken, helpText()); return;
  }

  if (command === "/ai") {
    const user = await getUser(lineId);
    if (!user?.ai_enabled) {
      await reply(event.replyToken, "🚫 AI機能は無効化されています。"); return;
    }
    const prompt = args.join(" ").trim();
    if (!prompt) {
      await reply(event.replyToken, "使い方：/ai <内容>"); return;
    }
    try {
      await reply(event.replyToken, await openRouterChat(prompt));
    } catch (e) {
      console.error("OpenRouter error:", e.response?.data || e);
      await reply(event.replyToken, "⚠️ AIとの通信に失敗しました。");
    }
    return;
  }

  if (command === "/mycoin") {
    const u = await getUser(lineId);
    await reply(event.replyToken, `💰 ${u?.coins ?? 0} coin`); return;
  }

  if (command === "/rank") {
    const coin = args[0]?.toLowerCase() === "coin";
    const rows = coin ? await getCoinRank(10) : await getMessageRank(10);
    await reply(event.replyToken, coin ? `💰 コインランキング\n${formatRank(rows, "coin")}` : `💬 発言回数ランキング\n${formatRank(rows, "message")}`);
    return;
  }

  if (command === "/rankcoin") {
    await reply(event.replyToken, `💰 コインランキング\n${formatRank(await getCoinRank(10), "coin")}`); return;
  }

  if (command === "/myrank") {
    const rank = await getMessagePosition(lineId), u = await getUser(lineId);
    await reply(event.replyToken, `🏆 あなたの発言順位\n${rank}位\n発言回数：${Number(u?.message_count || 0).toLocaleString()}回`); return;
  }

  if (command === "/login") {
    const r = await claimLoginBonus(lineId);
    await reply(event.replyToken, r.already
      ? `✅ 今日はすでに受け取り済みです。\n連続ログイン：${r.streak}日\n所持コイン：${r.coins.toLocaleString()}`
      : `🎁 ログインボーナス！\n+${r.reward} coin\n連続ログイン：${r.streak}日\n所持コイン：${r.coins.toLocaleString()}`);
    return;
  }

  if (command === "/tenki") {
    try { await reply(event.replyToken, await weather()); }
    catch { await reply(event.replyToken, "⚠️ 天気情報を取得できませんでした。"); }
    return;
  }

  if (command === "/omikuzi") {
    await reply(event.replyToken, drawOmikuzi()); return;
  }

  if (command === "/rob") {
    const targetId = extractMentionId(event);
    if (!targetId) { await reply(event.replyToken, "使い方：/rob @ユーザー"); return; }
    if (await hasRobbedToday(lineId)) { await reply(event.replyToken, "🚫 本日はすでに強盗をしています。"); return; }

    try {
      const r = await robCoins(lineId, targetId);
      if (!r.success) {
        await reply(event.replyToken, r.reason === "target_empty" ? "💨 強盗失敗！相手のコインが0でした。" : "💨 強盗失敗！10 coinを失いました。");
      } else {
        await reply(event.replyToken, `🎯 強盗成功！\n相手の${r.percent}%を奪って ${r.amount.toLocaleString()} coin獲得しました！`);
      }
    } catch (e) {
      await reply(event.replyToken,
        e.message === "not_enough_for_failure_fee" ? "❌ 強盗には最低10 coin必要です。" :
        e.message === "self_rob" ? "❌ 自分自身からは盗めません。" : "⚠️ 強盗処理に失敗しました。");
    }
    return;
  }

  if (command === "/coints") {
    const side = args[0], u = await getUser(lineId);
    if (!["表", "裏"].includes(side)) { await reply(event.replyToken, "使い方：/coints <表|裏> <金額|all>"); return; }
    const amount = parseAmount(args[1], Number(u?.coins || 0));
    if (!amount) { await reply(event.replyToken, "正しい金額を指定してください。"); return; }
    if (amount > Number(u.coins)) { await reply(event.replyToken, "❌ コインが足りません。"); return; }
    const result = Math.random() < 0.5 ? "表" : "裏";
    if (result === side) {
      await addCoins(lineId, amount);
      await reply(event.replyToken, `🪙 結果：${result}\n🎉 的中！\n+${amount.toLocaleString()} coin`);
    } else {
      await addCoins(lineId, -amount);
      await reply(event.replyToken, `🪙 結果：${result}\n💥 ハズレ！\n-${amount.toLocaleString()} coin`);
    }
    return;
  }

  if (command === "/slot") {
    const u = await getUser(lineId), amount = parseAmount(args[0], Number(u?.coins || 0));
    if (!amount) { await reply(event.replyToken, "使い方：/slot <金額|all>"); return; }
    if (amount > Number(u.coins)) { await reply(event.replyToken, "❌ コインが足りません。"); return; }
    const win = Math.floor(Math.random() * 20) === 0;
    if (win) {
      await addCoins(lineId, amount * 4);
      await reply(event.replyToken, `🎰 🎰 🎰\n🎉 JACKPOT！\n賭け金 ${amount.toLocaleString()} coin に対して5倍！`);
    } else {
      await addCoins(lineId, -amount);
      await reply(event.replyToken, `🎰 結果：ハズレ\n-${amount.toLocaleString()} coin`);
    }
    return;
  }

  if (command === "/pay") {
    const targetId = extractMentionId(event), amount = Number(args[0]);
    if (!targetId || !Number.isInteger(amount) || amount <= 0) { await reply(event.replyToken, "使い方：/pay <金額> @メンション"); return; }
    try {
      await ensureUser(targetId, await getDisplayName(targetId));
      await transferCoins(lineId, targetId, amount);
      await reply(event.replyToken, `💸 ${amount.toLocaleString()} coinを送金しました。`);
    } catch (e) {
      await reply(event.replyToken, e.message === "insufficient_coins" ? "❌ コインが足りません。" : "⚠️ 送金に失敗しました。");
    }
    return;
  }

  if (command === "/give") {
    if (!(await isAdmin(lineId))) { await reply(event.replyToken, "🚫 管理者専用です。"); return; }
    const targetId = extractMentionId(event), amount = Number(args[1]);
    if (args[0]?.toLowerCase() !== "coin" || !targetId || !Number.isInteger(amount) || amount <= 0) {
      await reply(event.replyToken, "使い方：/give coin <数> @メンション"); return;
    }
    await ensureUser(targetId, await getDisplayName(targetId));
    await addCoins(targetId, amount);
    await reply(event.replyToken, `👑 ${amount.toLocaleString()} coinを付与しました。`); return;
  }

  if (command === "/uid") {
    if (!(await isAdmin(lineId))) { await reply(event.replyToken, "🚫 管理者専用です。"); return; }
    const targetId = extractMentionId(event) || lineId, targetName = await getDisplayName(targetId);
    await reply(event.replyToken, `👤 ${targetName}\nLINE User ID:\n${targetId}`);
    await sendDiscordText(`🆔 **LINE UID取得**\nユーザー: ${targetName}\nLINE User ID: \`${targetId}\``); return;
  }

  if (command === "/admins") {
    if (!(await isAdmin(lineId))) { await reply(event.replyToken, "🚫 管理者専用です。"); return; }
    const a = await getAdmins();
    await reply(event.replyToken, `👑 管理者一覧\n${a.map((x,i) => `${i+1}. ${x.line_id}`).join("\n")}`); return;
  }

  if (command === "/resetrank") {
    if (!(await isAdmin(lineId))) { await reply(event.replyToken, "🚫 管理者専用です。"); return; }
    await resetMessageRank(); await reply(event.replyToken, "✅ 発言回数ランキングをリセットしました。"); return;
  }

  if (command === "/offbot" || command === "/onbot") {
    if (!(await isAdmin(lineId))) { await reply(event.replyToken, "🚫 管理者専用です。"); return; }
    const targetId = extractMentionId(event);
    if (!targetId) { await reply(event.replyToken, `使い方：${command} @メンション`); return; }
    await ensureUser(targetId, await getDisplayName(targetId));
    await setAiEnabled(targetId, command === "/onbot");
    await reply(event.replyToken, `${command === "/onbot" ? "🟢 AIを有効化" : "🔴 AIを無効化"}しました。`); return;
  }

  if (command === "/adminplususer") {
    if (!(await isAdmin(lineId))) { await reply(event.replyToken, "🚫 管理者専用です。"); return; }
    const targetId = args[0];
    if (!targetId || !/^U[a-zA-Z0-9]+$/.test(targetId)) {
      await reply(event.replyToken, "使い方：/adminplususer <LINE USER ID>"); return;
    }
    await addAdmin(targetId);
    await reply(event.replyToken, `👑 管理者を追加しました。\n${targetId}`);
    await sendDiscordText(`👑 **管理者追加**\n追加されたLINE User ID: \`${targetId}\`\n実行者: \`${lineId}\``);
    return;
  }

  await reply(event.replyToken, "❓ 不明なコマンドです。\n/help で一覧を確認できます。");
}

async function processEvent(event) {
  if (event.type !== "message") return;
  const lineId = sourceUserId(event);
  if (!lineId) return;

  const name = await getDisplayName(lineId);
  await incrementMessageCount(lineId, name);

  if (event.message.type === "text") {
    await logTextToDiscord(name, lineId, event.message.text, event);
    await handleText(event, lineId);
    return;
  }

  if (["image", "video", "audio", "file"].includes(event.message.type)) {
    await logMediaToDiscord(name, lineId, event);
    return;
  }

  await sendDiscordText(`**LINE会話ログ**\nユーザー: ${name}\nLINE ID: \`${lineId}\`\n種類: ${event.message.type}`);
}

await initDb();

app.listen(PORT, () => {
  console.log(`LINE Bot listening on port ${PORT}`);
  console.log(`Webhook: /webhook`);
});
