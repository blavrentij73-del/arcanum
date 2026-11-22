const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type"
};

const MAX_BOOTSTRAP_TROPHIES = 5000;
const WIN_MIN = 26;
const WIN_MAX = 34;
const LOSS_MAX = 20;

const CATALOG = {
  gems_xs: { title: "Искра — 1 гем", stars: 1, description: "Пробная покупка в Аркануме" },
  gems_s: { title: "120 гемов", stars: 75, description: "Пополнение коллекции Арканум" },
  gems_m: { title: "320 гемов", stars: 149, description: "Пополнение коллекции Арканум" },
  gems_l: { title: "800 гемов", stars: 299, description: "Пополнение коллекции Арканум" },
  season: { title: "Сезонный пропуск", stars: 199, description: "Премиум-ветка сезона «Пепел»" },
  first: { title: "Первый шаг", stars: 149, description: "300 гемов и три редких набора" }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS }
  });
}

function enc(s) {
  return new TextEncoder().encode(s);
}

async function hmac(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, msgBytes));
}

function toHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let res = 0;
  for (let i = 0; i < a.length; i++) res |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return res === 0;
}

async function verifyInitData(initData, botToken) {
  if (!initData || typeof initData !== "string") return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(k + "=" + v);
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secret = await hmac(enc("WebAppData"), enc(botToken));
  const signature = toHex(await hmac(secret, enc(dataCheckString)));
  if (!safeEqual(signature, hash.toLowerCase())) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;

  let user = null;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch (e) {
    return null;
  }
  if (!user || !user.id) return null;
  return user;
}

async function readBody(request) {
  try {
    return await request.json();
  } catch (e) {
    return {};
  }
}

async function telegram(env, method, payload) {
  const r = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  try {
    return await r.json();
  } catch (e) {
    return { ok: false, description: "bad telegram response" };
  }
}

async function invoice(request, env) {
  const body = await readBody(request);
  const user = await verifyInitData(body.initData, env.BOT_TOKEN);
  if (!user) return json({ error: "bad_init" }, 401);

  const kind = String(body.kind || "");
  const item = CATALOG[kind];
  if (!item) return json({ error: "unknown_kind" }, 400);

  const payload = kind + "|" + user.id + "|" + Date.now();
  const res = await telegram(env, "createInvoiceLink", {
    title: item.title,
    description: item.description,
    payload: payload,
    currency: "XTR",
    prices: [{ label: item.title, amount: item.stars }]
  });

  if (!res || !res.ok || !res.result) {
    return json({ error: "telegram", details: (res && res.description) || "no result" }, 502);
  }
  return json({ url: res.result });
}

async function claim(request, env) {
  const body = await readBody(request);
  const user = await verifyInitData(body.initData, env.BOT_TOKEN);
  if (!user) return json({ error: "bad_init" }, 401);

  const id = String(user.id);
  const rows = await env.DB.prepare(
    "SELECT id, kind, stars FROM purchases WHERE user_id = ? AND claimed = 0 ORDER BY created_at ASC LIMIT 20"
  ).bind(id).all();

  const items = (rows && rows.results) || [];
  if (items.length) {
    const stmt = env.DB.prepare("UPDATE purchases SET claimed = 1 WHERE id = ? AND user_id = ?");
    await env.DB.batch(items.map(function (it) { return stmt.bind(it.id, id); }));
  }

  return json({
    items: items.map(function (it) { return { kind: it.kind, stars: it.stars }; })
  });
}

async function webhook(request, env) {
  if (env.WEBHOOK_SECRET) {
    const secret = request.headers.get("x-telegram-bot-api-secret-token");
    if (secret !== env.WEBHOOK_SECRET) return json({ error: "forbidden" }, 403);
  }

  const update = await readBody(request);

  if (update.pre_checkout_query) {
    await telegram(env, "answerPreCheckoutQuery", {
      pre_checkout_query_id: update.pre_checkout_query.id,
      ok: true
    });
    return json({ ok: true });
  }

  const msg = update.message;
  if (msg && msg.successful_payment) {
    const sp = msg.successful_payment;
    const parts = String(sp.invoice_payload || "").split("|");
    const kind = parts[0];
    const payloadUser = parts[1];
    const payer = String((msg.from && msg.from.id) || "");

    if (CATALOG[kind] && payloadUser === payer) {
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        `INSERT OR IGNORE INTO purchases (id, user_id, kind, stars, claimed, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`
      ).bind(sp.telegram_payment_charge_id, payer, kind, sp.total_amount, now).run();

      const name = String((msg.from && msg.from.first_name) || "Игрок").slice(0, 20);
      await env.DB.prepare(
        `INSERT INTO players (user_id, name, trophies, best, season, updated_at, last_battle_at)
         VALUES (?, ?, 0, 0, ?, ?, 0)
         ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at`
      ).bind(payer, name, new Date().toISOString().slice(0, 7), now).run();
    }

    return json({ ok: true });
  }

  if (msg && typeof msg.text === "string" && msg.text.indexOf("/start") === 0 && env.APP_URL) {
    await telegram(env, "sendMessage", {
      chat_id: msg.chat.id,
      text: "Арканум — карточная коллекция. Открывай свод.",
      reply_markup: { inline_keyboard: [[{ text: "Играть", web_app: { url: env.APP_URL } }]] }
    });
    return json({ ok: true });
  }

  return json({ ok: true });
}

async function sync(request, env) {
  const body = await readBody(request);
  const user = await verifyInitData(body.initData, env.BOT_TOKEN);
  if (!user) return json({ error: "bad_init" }, 401);

  const id = String(user.id);
  const name = String(user.first_name || user.username || "Игрок").slice(0, 20);
  const seed = Math.max(0, Math.min(MAX_BOOTSTRAP_TROPHIES, Number(body.trophies) || 0));
  const now = Math.floor(Date.now() / 1000);
  const season = new Date().toISOString().slice(0, 7);

  await env.DB.prepare(
    `INSERT INTO players (user_id, name, trophies, best, season, updated_at, last_battle_at)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`
  ).bind(id, name, seed, seed, season, now).run();

  const row = await env.DB.prepare(
    "SELECT trophies, best FROM players WHERE user_id = ?"
  ).bind(id).first();

  const rankRow = await env.DB.prepare(
    "SELECT COUNT(*) + 1 AS rank FROM players WHERE trophies > ?"
  ).bind(row.trophies).first();

  return json({
    player: { name: name, trophies: row.trophies, best: row.best },
    rank: rankRow ? rankRow.rank : null
  });
}

async function battle(request, env) {
  const body = await readBody(request);
  const user = await verifyInitData(body.initData, env.BOT_TOKEN);
  if (!user) return json({ error: "bad_init" }, 401);

  const id = String(user.id);
  const from = Number(body.from);
  const to = Number(body.to);
  const won = !!body.won;

  if (!Number.isFinite(from) || !Number.isFinite(to)) return json({ error: "bad_numbers" }, 400);

  const row = await env.DB.prepare(
    "SELECT trophies, best FROM players WHERE user_id = ?"
  ).bind(id).first();
  if (!row) return json({ error: "unknown_player", trophies: 0 }, 409);

  if (from !== row.trophies) {
    return json({ error: "desync", trophies: row.trophies, best: row.best }, 409);
  }

  const delta = to - from;
  const legal = won
    ? delta >= WIN_MIN && delta <= WIN_MAX
    : delta <= 0 && delta >= -LOSS_MAX;
  if (!legal) return json({ error: "illegal_delta" }, 400);

  const now = Math.floor(Date.now() / 1000);
  const best = Math.max(row.best, to);

  await env.DB.prepare(
    "UPDATE players SET trophies = ?, best = ?, last_battle_at = ?, updated_at = ? WHERE user_id = ?"
  ).bind(to, best, now, now, id).run();

  return json({ ok: true, trophies: to, best: best });
}

async function leaderboard(request, env) {
  const body = await readBody(request);
  const user = await verifyInitData(body.initData, env.BOT_TOKEN);
  if (!user) return json({ error: "bad_init" }, 401);

  const id = String(user.id);
  const limit = Math.min(100, Math.max(10, Number(body.limit) || 50));

  const list = await env.DB.prepare(
    "SELECT name, trophies FROM players ORDER BY trophies DESC, updated_at ASC LIMIT ?"
  ).bind(limit).all();

  const me = await env.DB.prepare(
    "SELECT trophies, best FROM players WHERE user_id = ?"
  ).bind(id).first();

  let rank = null;
  if (me) {
    const rankRow = await env.DB.prepare(
      "SELECT COUNT(*) + 1 AS rank FROM players WHERE trophies > ?"
    ).bind(me.trophies).first();
    rank = rankRow ? rankRow.rank : null;
  }

  return json({
    items: (list && list.results) || [],
    me: me ? { trophies: me.trophies, rank: rank } : null
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (!env.BOT_TOKEN) {
      return json({ error: "no_bot_token", hint: "wrangler secret put BOT_TOKEN" }, 500);
    }
    if (!env.DB) {
      return json({ error: "no_database", hint: "привяжите D1 как DB в wrangler.toml" }, 500);
    }

    try {
      if (url.pathname === "/api/sync" && request.method === "POST") return sync(request, env);
      if (url.pathname === "/api/battle" && request.method === "POST") return battle(request, env);
      if (url.pathname === "/api/leaderboard" && request.method === "POST") return leaderboard(request, env);
      if (url.pathname === "/api/invoice" && request.method === "POST") return invoice(request, env);
      if (url.pathname === "/api/claim" && request.method === "POST") return claim(request, env);
      if (url.pathname === "/webhook" && request.method === "POST") return webhook(request, env);
      if (url.pathname === "/" || url.pathname === "/api/health") {
        return json({ ok: true, service: "arcanum-api" });
      }
    } catch (e) {
      return json({ error: "internal", message: String((e && e.message) || e) }, 500);
    }

    return json({ error: "not_found" }, 404);
  }
};
