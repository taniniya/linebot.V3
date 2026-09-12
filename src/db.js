import "dotenv/config";
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL が設定されていません");
}

export const sql = neon(process.env.DATABASE_URL);

export async function initDb() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      line_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT 'Unknown',
      coins BIGINT NOT NULL DEFAULT 0,
      message_count BIGINT NOT NULL DEFAULT 0,
      login_streak INTEGER NOT NULL DEFAULT 0,
      last_login_date DATE,
      ai_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS admins (
      line_id TEXT PRIMARY KEY,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS rob_history (
      id BIGSERIAL PRIMARY KEY,
      robber_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      success BOOLEAN NOT NULL,
      amount BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_users_message_count ON users(message_count DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_users_coins ON users(coins DESC)`;

  for (const id of (process.env.ADMIN_IDS || "").split(",").map(v => v.trim()).filter(Boolean)) {
    await sql`INSERT INTO admins (line_id) VALUES (${id}) ON CONFLICT (line_id) DO NOTHING`;
  }
}

export async function ensureUser(lineId, displayName = "Unknown") {
  const rows = await sql`
    INSERT INTO users (line_id, display_name)
    VALUES (${lineId}, ${displayName})
    ON CONFLICT (line_id)
    DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = NOW()
    RETURNING *
  `;
  return rows[0];
}

export async function incrementMessageCount(lineId, displayName) {
  const rows = await sql`
    INSERT INTO users (line_id, display_name, message_count)
    VALUES (${lineId}, ${displayName}, 1)
    ON CONFLICT (line_id)
    DO UPDATE SET
      display_name = EXCLUDED.display_name,
      message_count = users.message_count + 1,
      updated_at = NOW()
    RETURNING *
  `;
  return rows[0];
}

export async function getUser(lineId) {
  const rows = await sql`SELECT * FROM users WHERE line_id = ${lineId}`;
  return rows[0] || null;
}

export async function isAdmin(lineId) {
  const rows = await sql`SELECT 1 FROM admins WHERE line_id = ${lineId} LIMIT 1`;
  return rows.length > 0;
}

export async function addAdmin(lineId) {
  await sql`INSERT INTO admins (line_id) VALUES (${lineId}) ON CONFLICT (line_id) DO NOTHING`;
}

export async function getAdmins() {
  return sql`SELECT line_id, added_at FROM admins ORDER BY added_at ASC`;
}

export async function addCoins(lineId, amount) {
  const rows = await sql`
    UPDATE users SET coins = coins + ${amount}, updated_at = NOW()
    WHERE line_id = ${lineId} RETURNING *
  `;
  return rows[0] || null;
}

export async function transferCoins(fromId, toId, amount) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("invalid_amount");
  const result = await sql.transaction([
    sql`SELECT coins FROM users WHERE line_id = ${fromId} FOR UPDATE`,
    sql`SELECT coins FROM users WHERE line_id = ${toId} FOR UPDATE`
  ]);
  const sender = result[0][0], receiver = result[1][0];
  if (!sender || !receiver) throw new Error("user_not_found");
  if (Number(sender.coins) < amount) throw new Error("insufficient_coins");

  await sql.transaction([
    sql`UPDATE users SET coins = coins - ${amount}, updated_at = NOW() WHERE line_id = ${fromId}`,
    sql`UPDATE users SET coins = coins + ${amount}, updated_at = NOW() WHERE line_id = ${toId}`
  ]);
}

export async function getMessageRank(limit = 10) {
  return sql`
    SELECT line_id, display_name, message_count, coins
    FROM users ORDER BY message_count DESC, line_id ASC LIMIT ${limit}
  `;
}

export async function getCoinRank(limit = 10) {
  return sql`
    SELECT line_id, display_name, coins, message_count
    FROM users ORDER BY coins DESC, line_id ASC LIMIT ${limit}
  `;
}

export async function getMessagePosition(lineId) {
  const rows = await sql`
    SELECT COUNT(*)::INTEGER + 1 AS rank
    FROM users
    WHERE message_count > (
      SELECT COALESCE(message_count, 0) FROM users WHERE line_id = ${lineId}
    )
  `;
  return Number(rows[0]?.rank || 1);
}

function jstDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.TIMEZONE || "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}

function previousDateString(dateString) {
  const d = new Date(`${dateString}T00:00:00+09:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function claimLoginBonus(lineId) {
  const today = jstDateString();
  const yesterday = previousDateString(today);
  const rows = await sql`SELECT * FROM users WHERE line_id = ${lineId}`;
  const user = rows[0];
  if (!user) throw new Error("user_not_found");

  if (user.last_login_date && String(user.last_login_date).slice(0, 10) === today) {
    return { already: true, streak: Number(user.login_streak), reward: 0, coins: Number(user.coins) };
  }

  let streak = 1;
  if (user.last_login_date && String(user.last_login_date).slice(0, 10) === yesterday) {
    streak = Math.min(Number(user.login_streak) + 1, 7);
  }
  const reward = streak * 10;

  const updated = await sql`
    UPDATE users SET
      login_streak = ${streak},
      last_login_date = ${today},
      coins = coins + ${reward},
      updated_at = NOW()
    WHERE line_id = ${lineId} RETURNING coins
  `;
  return { already: false, streak, reward, coins: Number(updated[0].coins) };
}

export async function hasRobbedToday(lineId) {
  const rows = await sql`
    SELECT 1 FROM rob_history
    WHERE robber_id = ${lineId}
      AND (created_at AT TIME ZONE 'Asia/Tokyo')::DATE =
          (NOW() AT TIME ZONE 'Asia/Tokyo')::DATE
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function robCoins(robberId, targetId) {
  if (robberId === targetId) throw new Error("self_rob");

  const result = await sql.transaction([
    sql`SELECT coins FROM users WHERE line_id = ${robberId} FOR UPDATE`,
    sql`SELECT coins FROM users WHERE line_id = ${targetId} FOR UPDATE`
  ]);
  const robber = result[0][0], target = result[1][0];

  if (!robber || !target) throw new Error("user_not_found");
  if (Number(robber.coins) < 10) throw new Error("not_enough_for_failure_fee");

  const success = Math.random() < 0.20;

  if (!success) {
    await sql`UPDATE users SET coins = GREATEST(coins - 10, 0), updated_at = NOW() WHERE line_id = ${robberId}`;
    await sql`
      INSERT INTO rob_history (robber_id, target_id, success, amount)
      VALUES (${robberId}, ${targetId}, FALSE, 10)
    `;
    return { success: false, amount: 10 };
  }

  const targetCoins = Number(target.coins);
  if (targetCoins <= 0) {
    await sql`
      INSERT INTO rob_history (robber_id, target_id, success, amount)
      VALUES (${robberId}, ${targetId}, FALSE, 0)
    `;
    return { success: false, amount: 0, reason: "target_empty" };
  }

  const percent = Math.floor(Math.random() * 30) + 1;
  const amount = Math.max(1, Math.floor(targetCoins * percent / 100));

  await sql.transaction([
    sql`UPDATE users SET coins = coins + ${amount}, updated_at = NOW() WHERE line_id = ${robberId}`,
    sql`UPDATE users SET coins = coins - ${amount}, updated_at = NOW() WHERE line_id = ${targetId}`,
    sql`
      INSERT INTO rob_history (robber_id, target_id, success, amount)
      VALUES (${robberId}, ${targetId}, TRUE, ${amount})
    `
  ]);
  return { success: true, amount, percent };
}

export async function resetMessageRank() {
  await sql`UPDATE users SET message_count = 0, updated_at = NOW()`;
}

export async function setAiEnabled(lineId, enabled) {
  const rows = await sql`
    UPDATE users SET ai_enabled = ${enabled}, updated_at = NOW()
    WHERE line_id = ${lineId} RETURNING *
  `;
  return rows[0] || null;
}
