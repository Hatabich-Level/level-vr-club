require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* ================= ENV ================= */
const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SITE_URL = process.env.SITE_URL;
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim(); // для входу через Google (необовʼязково)

/* ================= ROLES ================= */
const isOwner = (id) => id.toString() === OWNER_CHAT_ID;
const isAdmin = (id) =>
  id.toString() === OWNER_CHAT_ID || id.toString() === ADMIN_CHAT_ID;


/* ================= SECURITY ================= */
// Жодна несподівана помилка в async-коді не має валити сервер
process.on('unhandledRejection', (err) => {
  console.error('Необроблена помилка (сервер продовжує працювати):', err);
});

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Сайти, яким дозволено звертатись до API. Додати ще: ALLOWED_ORIGINS=https://a.com,https://b.com
const normOrigin = (o) => { try { return new URL(o).origin; } catch { return ''; } };
const ALLOWED_ORIGINS = new Set(
  [
    'https://level-vr-club.vn.ua',
    'https://www.level-vr-club.vn.ua',
    'https://level-vr-club.onrender.com',
    SITE_URL,
    ...(process.env.ALLOWED_ORIGINS || '').split(',')
  ].map((o) => normOrigin((o || '').trim())).filter(Boolean)
);
const isAllowedOrigin = (origin) =>
  !origin || ALLOWED_ORIGINS.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

app.use(cors({ origin: (origin, cb) => cb(null, isAllowedOrigin(origin)) }));
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, '../FrondEnd')));

/* ================= IGDB (TWITCH) API SETUP ================= */
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
let igdbAccessToken = null;

async function getIgdbToken() {
    if (igdbAccessToken) return igdbAccessToken;
    try {
        const res = await axios.post(`https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`);
        igdbAccessToken = res.data.access_token;
        return igdbAccessToken;
    } catch (err) {
        console.error("Помилка отримання токена Twitch:", err.message);
        return null;
    }
}

/* ================= BOT ================= */
const bot = new TelegramBot(TOKEN, { polling: true });

/* ================= DB ================= */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  const client = await pool.connect();
  
  // Таблиця замовлень (вже є)
  await client.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      name TEXT,
      phone TEXT,
      booking_date TEXT,
      booking_time TEXT,
      total_price NUMERIC,
      cart_details JSONB,
      comment TEXT,
      client_chat_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings (booking_date)`);

  // Секретний токен для привʼязки клієнта до замовлення через Telegram-бота
  await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS claim_token TEXT`);

  // Акаунти клієнтів (вхід через Telegram або Google) та їхні сесії
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id TEXT UNIQUE,
      google_sub TEXT UNIQUE,
      email TEXT,
      name TEXT,
      username TEXT,
      phone TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login_at TIMESTAMP
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL
    );
  `);
  await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS user_id INTEGER`);
  await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS confirmed BOOLEAN DEFAULT FALSE`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings (user_id)`);

  // НОВА ТАБЛИЦЯ ДЛЯ ІГОР
  await client.query(`
    CREATE TABLE IF NOT EXISTS games (
      id SERIAL PRIMARY KEY,
      title TEXT,
      platform TEXT,
      description TEXT,
      image_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  client.release();
})();


/* ================= ONLINE ================= */
let onlineUsers = 0;
io.on('connection', (socket) => {
  onlineUsers++;
  socket.on('disconnect', () => onlineUsers--);
});

/* ================= ROUTE ================= */
app.get('/', (req, res) => res.send('Server OK'));

/* ================= START ================= */
bot.onText(/\/start(?: (.*))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const payload = match[1];

  try {
    if (payload && payload.startsWith('login_')) {
      return await handleLoginStart(msg, payload.slice(6));
    }

    if (payload && payload.startsWith('order_')) {
      // Формат: order_<id>_<секретний токен із відповіді сервера>
      const [, idStr, token] = payload.split('_');

      if (!/^\d{1,9}$/.test(idStr || '') || !/^[0-9a-f]{16}$/.test(token || '')) {
        return bot.sendMessage(chatId, '⚠️ Посилання недійсне або застаріло. Якщо ви щойно створили бронювання, зверніться до адміністратора.');
      }

      const found = await pool.query('SELECT claim_token FROM bookings WHERE id=$1', [Number(idStr)]);
      const saved = found.rows[0] && found.rows[0].claim_token;
      const ok = saved && saved.length === token.length &&
        crypto.timingSafeEqual(Buffer.from(saved), Buffer.from(token));

      if (!ok) {
        return bot.sendMessage(chatId, '⚠️ Посилання недійсне або застаріло. Якщо ви щойно створили бронювання, зверніться до адміністратора.');
      }

      await pool.query('UPDATE bookings SET client_chat_id=$1 WHERE id=$2', [chatId, Number(idStr)]);
      bot.sendMessage(chatId, `✅ Ви підключені до замовлення #${idStr}`);
    } else if (!isAdmin(chatId)) {
      bot.sendMessage(chatId, "🎮 Вітаємо у LEVEL VR CLUB!");
    }
  } catch (e) {
    console.error('Помилка /start:', e.message);
  }
});

/* ================= ADMIN COMMANDS ================= */
bot.onText(/\/clear/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  await pool.query('TRUNCATE bookings RESTART IDENTITY');
  bot.sendMessage(msg.chat.id, '🧹 Базу очищено');
});

bot.onText(/\/today/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;

  const today = new Date().toISOString().split('T')[0];
  const res = await pool.query('SELECT * FROM bookings WHERE booking_date=$1 ORDER BY booking_time', [today]);

  if (!res.rows.length) return bot.sendMessage(msg.chat.id, 'Немає замовлень');

  let text = '📅 СЬОГОДНІ:\n\n';
  res.rows.forEach(b => text += `${b.booking_time} - ${b.name} (#${b.id})\n`);
  bot.sendMessage(msg.chat.id, text);
});

/* ================= ANTI-SPAM ================= */
// IP клієнта (за проксі Render/Cloudflare)
const clientIp = (req) =>
  req.headers['cf-connecting-ip'] ||
  String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket.remoteAddress ||
  'unknown';

// Простий ліміт запитів у памʼяті (без додаткових бібліотек)
function createLimiter({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) {
      const fresh = arr.filter((t) => now - t < windowMs);
      if (fresh.length) hits.set(k, fresh); else hits.delete(k);
    }
  }, 60 * 1000).unref();

  return (req, res, next) => {
    const key = clientIp(req);
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      res.set('Retry-After', String(Math.ceil((arr[0] + windowMs - now) / 1000)));
      return res.status(429).json({ success: false, code: 'RATE', message });
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}

const CALL_US = 'Зателефонуйте нам: 098 589 73 88.';
const TOO_MANY = `Забагато запитів. Спробуйте трохи пізніше. ${CALL_US}`;
app.use('/api', createLimiter({ windowMs: 60 * 1000, max: 120, message: TOO_MANY }));
const bookBurstLimit = createLimiter({ windowMs: 10 * 60 * 1000, max: 8, message: TOO_MANY });
const bookDailyLimit = createLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 25, message: TOO_MANY });

// Загальна стеля прийнятих бронювань на годину: захищає чат адміна від потопу
const GLOBAL_MAX_PER_HOUR = 40;
const acceptedAt = [];
function globalCapReached() {
  const now = Date.now();
  while (acceptedAt.length && now - acceptedAt[0] > 60 * 60 * 1000) acceptedAt.shift();
  return acceptedAt.length >= GLOBAL_MAX_PER_HOUR;
}

// Токен форми: сайт отримує його при відкритті сторінки, а сервер приймає
// лише якщо з того часу минуло 3+ секунди, не більше 2 годин, і лише один раз.
const FORM_SECRET = process.env.FORM_SECRET || TOKEN || 'level-vr-club';
const FORM_TOKEN_MIN_AGE = 3 * 1000;
const FORM_TOKEN_MAX_AGE = 2 * 60 * 60 * 1000;
const usedFormTokens = new Map(); // nonce -> коли можна забути
setInterval(() => {
  const now = Date.now();
  for (const [nonce, expires] of usedFormTokens) if (expires < now) usedFormTokens.delete(nonce);
}, 10 * 60 * 1000).unref();

const signFormToken = (ts, nonce) =>
  crypto.createHmac('sha256', FORM_SECRET).update(`${ts}.${nonce}`).digest('hex').slice(0, 32);

app.get('/api/form-token', (req, res) => {
  const ts = Date.now();
  const nonce = crypto.randomBytes(8).toString('hex');
  res.set('Cache-Control', 'no-store');
  res.json({ token: `${ts}.${nonce}.${signFormToken(ts, nonce)}` });
});

function checkFormToken(token) {
  const refresh = 'Оновіть сторінку та спробуйте ще раз.';
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { error: refresh };

  const [tsStr, nonce, sig] = parts;
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || !/^[0-9a-f]{16}$/.test(nonce)) return { error: refresh };

  const expected = signFormToken(ts, nonce);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return { error: refresh };
  }

  const age = Date.now() - ts;
  if (age > FORM_TOKEN_MAX_AGE) return { error: `Сторінка відкрита надто довго. ${refresh}` };
  if (age < FORM_TOKEN_MIN_AGE) return { error: 'Зачекайте кілька секунд і натисніть ще раз.' };
  if (usedFormTokens.has(nonce)) return { error: `Це бронювання вже відправлене. ${refresh}` };
  return { nonce };
}

// Перевірка й очищення даних бронювання (клієнтським перевіркам довіряти не можна)
function validateBooking(b) {
  const clean = (v, max) =>
    String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const fail = (message) => ({ error: message });

  const name = clean(b.name, 60);
  if (name.length < 2) return fail('Вкажіть, будь ласка, ім’я.');

  const phone = clean(b.phone, 25);
  const digits = phone.replace(/\D/g, '');
  if (!/^[+\d\s()\-.]+$/.test(phone) || digits.length < 10 || digits.length > 13) {
    return fail('Вкажіть коректний номер телефону.');
  }

  const date = String(b.date ?? '');
  const time = String(b.time ?? '');
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!dm || !tm) return fail('Вкажіть коректні дату та час.');

  const [y, mo, d] = [dm[1], dm[2], dm[3]].map(Number);
  const [hh, mm] = [tm[1], tm[2]].map(Number);
  const when = new Date(y, mo - 1, d, hh, mm);
  if (when.getFullYear() !== y || when.getMonth() !== mo - 1 || when.getDate() !== d) {
    return fail('Такої дати не існує.');
  }

  const now = kyivNow();
  if (when < now) return fail('Цей час уже минув. Оберіть пізніший.');
  if (when - now > 365 * 24 * 60 * 60 * 1000) return fail('Бронювання можливе не більш ніж на рік уперед.');

  const startMin = hh * 60 + mm;
  if (startMin < 10 * 60 || startMin >= 22 * 60) {
    return fail('Клуб працює щодня з 10:00 до 22:00. Оберіть час у цей проміжок.');
  }

  if (!Array.isArray(b.cart) || b.cart.length < 1 || b.cart.length > 10) {
    return fail('Кошик порожній або занадто великий.');
  }

  const cart = [];
  let total = 0;
  for (const it of b.cart) {
    if (!it || typeof it !== 'object') return fail('Некоректні дані замовлення.');
    const device = clean(it.device || it.name || it.title, 120);
    const duration = Number(it.duration);
    const price = Number(it.price);
    const persons = Number(it.persons);
    if (!device || !(duration > 0 && duration <= 12) || !(price >= 0 && price <= 50000)) {
      return fail('Некоректні дані замовлення.');
    }
    cart.push({ device, duration, persons: Number.isFinite(persons) ? persons : undefined, price });
    total += price;
  }

  const longest = Math.max(...cart.map((c) => c.duration));
  if (startMin + longest * 60 > 22 * 60) {
    return fail(`Клуб працює до 22:00. Для ${longest} год найпізніший початок — ${22 - longest}:00.`);
  }

  const comment = clean(b.comment, 500) || 'Немає';
  return { data: { name, phone, digits, date, time, cart, total, comment } };
}

const PHONE_TAIL_SQL = "RIGHT(regexp_replace(phone, '\\D', '', 'g'), 9)";

/* ================= AVAILABILITY (ВІЛЬНІ МІСЦЯ) ================= */
// Обладнання клубу:
//  • 3 звичайні PS5 (на кожній можна грати вдвох, але це одна приставка);
//  • 2 окремі Oculus;
//  • 1 PS VR2, підʼєднаний до 3-ї PS5: поки на ньому грають, ця приставка зайнята;
//  • VIP-кімната: своя PS5 і свій VR, бронюється цілою кімнатою.
const CAPACITY = { ps5: 3, oculus: 2, vr2: 1, vip: 1 };
const OPEN_MIN = 10 * 60;
const CLOSE_MIN = 22 * 60;

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// Яке обладнання займає позиція замовлення (за назвою, яку надсилає сайт)
function classifyItem(item) {
  const name = String((item && (item.device || item.name || item.title)) || '');
  const u = { ps5: 0, oculus: 0, vr2: 0, vrAny: 0, vip: 0 };

  if (/VIP/i.test(name)) { u.vip = 1; return u; }

  if (/^День народження/i.test(name)) {
    const vr = /VR \((\d+) ос/i.exec(name);
    if (vr) { u.vrAny = Number(vr[1]); return u; }          // будь-який вільний VR
    const duo = /PS5 по двоє \((\d+) станц/i.exec(name);
    if (duo) { u.ps5 = Number(duo[1]); return u; }
    if (/PS5/i.test(name)) { u.ps5 = 1; return u; }
    return u;
  }

  if (/oculus/i.test(name)) { u.oculus = 1; return u; }
  if (/VR\s*2|PS\s*VR/i.test(name)) { u.vr2 = 1; return u; }
  if (/PS\s*5|PlayStation/i.test(name)) { u.ps5 = 1; return u; }
  return u; // невідома послуга: не блокуємо
}

function itemIntervals(startMin, cart) {
  const out = [];
  for (const it of cart || []) {
    const units = classifyItem(it);
    if (!(units.ps5 || units.oculus || units.vr2 || units.vrAny || units.vip)) continue;
    const dur = Number(it && it.duration) > 0 ? Number(it.duration) * 60 : 60;
    out.push({ start: startMin, end: startMin + dur, ...units });
  }
  return out;
}

// Рядки бронювань одного дня -> інтервали зайнятості обладнання
function dayIntervals(rows) {
  const out = [];
  for (const r of rows || []) {
    const start = toMin(r.booking_time);
    if (start === null) continue;
    let cart = r.cart_details;
    if (typeof cart === 'string') { try { cart = JSON.parse(cart); } catch { cart = []; } }
    out.push(...itemIntervals(start, Array.isArray(cart) ? cart : []));
  }
  return out;
}

function usageAt(intervals, t) {
  const u = { ps5: 0, oculus: 0, vr2: 0, vrAny: 0, vip: 0 };
  for (const i of intervals) {
    if (i.start <= t && t < i.end) {
      u.ps5 += i.ps5; u.oculus += i.oculus; u.vr2 += i.vr2; u.vrAny += i.vrAny; u.vip += i.vip;
    }
  }
  return u;
}

// Скільки обладнання вільно (і чи не перевищено ліміти) при такому завантаженні
function freeFromUsage(u) {
  const x = Math.min(u.vrAny, Math.max(0, CAPACITY.oculus - u.oculus)); // «будь-який VR» спершу на Oculus
  const y = u.vrAny - x;                                                // решта на PS VR2
  const oculusUsed = u.oculus + x;
  const vr2Used = u.vr2 + y;
  const ps5Used = u.ps5 + vr2Used;                                      // PS VR2 займає 3-тю PS5
  return {
    ok: oculusUsed <= CAPACITY.oculus && vr2Used <= CAPACITY.vr2 && ps5Used <= CAPACITY.ps5 && u.vip <= CAPACITY.vip,
    free: {
      ps5: CAPACITY.ps5 - ps5Used,
      oculus: CAPACITY.oculus - oculusUsed,
      vr2: Math.min(CAPACITY.vr2 - vr2Used, CAPACITY.ps5 - ps5Used),
      vip: CAPACITY.vip - u.vip
    }
  };
}

// Моменти, у які змінюється завантаження: початок вікна і старти бронювань усередині нього
function checkpoints(intervals, from, to) {
  const pts = new Set([from]);
  for (const i of intervals) if (i.start > from && i.start < to) pts.add(i.start);
  return [...pts];
}

// Скільки гарантовано вільно протягом усього вікна [from, to)
function windowFree(existing, from, to) {
  const min = { ps5: CAPACITY.ps5, oculus: CAPACITY.oculus, vr2: CAPACITY.vr2, vip: CAPACITY.vip };
  for (const t of checkpoints(existing, from, to)) {
    const f = freeFromUsage(usageAt(existing, t)).free;
    for (const k of Object.keys(min)) min[k] = Math.min(min[k], Math.max(0, f[k]));
  }
  return min;
}

function fits(existing, requested) {
  if (!requested.length) return true;
  const from = Math.min(...requested.map((r) => r.start));
  const to = Math.max(...requested.map((r) => r.end));
  const all = existing.concat(requested);
  return checkpoints(all, from, to).every((t) => freeFromUsage(usageAt(all, t)).ok);
}

function kyivToday() {
  const n = kyivNow();
  return { date: `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`, min: n.getHours() * 60 + n.getMinutes() };
}

// Найближчі вільні старти (крок 30 хв) для того самого набору обладнання
function suggestStarts(existing, cart, date, requestedStart) {
  const maxDur = Math.max(60, ...cart.map((i) => (Number(i.duration) || 1) * 60));
  const today = kyivToday();
  const out = [];
  for (let s = OPEN_MIN; s + maxDur <= CLOSE_MIN; s += 30) {
    if (s === requestedStart) continue;
    if (date === today.date && s < today.min) continue;
    if (fits(existing, itemIntervals(s, cart))) out.push(s);
  }
  out.sort((a, b) => Math.abs(a - requestedStart) - Math.abs(b - requestedStart));
  return out.slice(0, 4).sort((a, b) => a - b).map(hhmm);
}

function shortageMessage(startMin, endMin, need, free, suggestions) {
  const line = (label, total, f, asked) => `${label}: вільно ${f} з ${total} (зайнято ${total - f}), а ви обрали ${asked}`;
  const parts = [];
  if (need.ps5 > free.ps5) parts.push(line('PlayStation 5', CAPACITY.ps5, free.ps5, need.ps5));
  if (need.oculus > free.oculus) parts.push(line('Oculus 2', CAPACITY.oculus, free.oculus, need.oculus));
  if (need.vr2 > free.vr2) parts.push('PS VR2: зайнятий на цей час (він підʼєднаний до 3-ї PS5, тому потрібна й вона)');
  if (need.vrAny > free.oculus + free.vr2) {
    parts.push(line('VR-окуляри', CAPACITY.oculus + CAPACITY.vr2, free.oculus + free.vr2, need.vrAny));
  }
  if (need.vip > free.vip) parts.push('VIP-кімната: зайнята на цей час');
  if (!parts.length) parts.push(`разом з обраним обладнанням місць не вистачає (PS5 вільно ${free.ps5} з ${CAPACITY.ps5}, Oculus ${free.oculus} з ${CAPACITY.oculus}, PS VR2 ${free.vr2 ? 'вільний' : 'зайнятий'})`);

  const tail = suggestions.length
    ? ` Найближчий вільний час: ${suggestions.join(', ')}.`
    : ' На цей день вільного часу для такого набору немає.';
  return `На ${hhmm(startMin)}–${hhmm(endMin)} не вистачає вільних місць. ${parts.join('; ')}.${tail}`;
}

// Чи можна поставити це замовлення поверх уже наявних бронювань дня
function evaluateRequest(existing, date, time, cart) {
  const start = toMin(time);
  const requested = itemIntervals(start, cart);
  if (fits(existing, requested)) return { ok: true };

  const end = Math.max(...requested.map((r) => r.end));
  const free = windowFree(existing, start, end);
  const need = requested.reduce(
    (n, r) => ({ ps5: n.ps5 + r.ps5, oculus: n.oculus + r.oculus, vr2: n.vr2 + r.vr2, vrAny: n.vrAny + r.vrAny, vip: n.vip + r.vip }),
    { ps5: 0, oculus: 0, vr2: 0, vrAny: 0, vip: 0 }
  );
  const suggestions = suggestStarts(existing, cart, date, start);
  return { ok: false, free, suggestions, message: shortageMessage(start, end, need, free, suggestions) };
}

const loadDayRows = (db, date) =>
  db.query('SELECT booking_time, cart_details FROM bookings WHERE booking_date = $1', [date]);

// Для сайту: скільки вільно на обраний час і чи пройде обраний набір (без створення бронювання)
app.post('/api/availability', async (req, res) => {
  try {
    if (!isAllowedOrigin(req.headers.origin)) return res.status(403).json({ success: false, message: 'Заборонено.' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const date = String(b.date || '');
    const time = String(b.time || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      return res.status(400).json({ success: false, message: 'Вкажіть дату й час.' });
    }

    const cart = (Array.isArray(b.cart) ? b.cart : []).slice(0, 10).map((it) => ({
      device: String((it && it.device) || '').slice(0, 120),
      duration: Number(it && it.duration) > 0 && Number(it.duration) <= 12 ? Number(it.duration) : 1,
      persons: Number(it && it.persons) || undefined
    }));
    const hours = cart.length ? Math.max(...cart.map((i) => i.duration)) : (Number(b.hours) > 0 && Number(b.hours) <= 12 ? Number(b.hours) : 1);

    const start = toMin(time);
    const rows = await loadDayRows(pool, date);
    const existing = dayIntervals(rows.rows);
    const free = windowFree(existing, start, start + hours * 60);

    const out = {
      success: true, date, time, hours,
      open: start >= OPEN_MIN && start + hours * 60 <= CLOSE_MIN,
      resources: {
        ps5: { total: CAPACITY.ps5, free: free.ps5, busy: CAPACITY.ps5 - free.ps5 },
        oculus: { total: CAPACITY.oculus, free: free.oculus, busy: CAPACITY.oculus - free.oculus },
        vr2: { total: CAPACITY.vr2, free: free.vr2, busy: CAPACITY.vr2 - free.vr2 },
        vip: { total: CAPACITY.vip, free: free.vip, busy: CAPACITY.vip - free.vip }
      }
    };

    const verdict = cart.length ? evaluateRequest(existing, date, time, cart) : { ok: true };
    out.ok = verdict.ok;
    if (!verdict.ok) { out.message = verdict.message; out.suggestions = verdict.suggestions; }

    res.set('Cache-Control', 'no-store');
    res.json(out);
  } catch (err) {
    console.error('availability:', err.message);
    res.status(500).json({ success: false, message: 'Не вдалося перевірити вільні місця.' });
  }
});

/* ================= AUTH (ВХІД: TELEGRAM + ЗАПАСНИЙ GOOGLE) ================= */
const SESSION_DAYS = 30;
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const authOrigin = (req, res) => {
  if (isAllowedOrigin(req.headers.origin)) return true;
  res.status(403).json({ success: false, message: 'Заборонено.' });
  return false;
};

// Що про акаунт можна віддавати на сайт
const publicUser = (u) => ({
  id: u.id,
  name: u.name || '',
  phone: u.phone || '',
  email: u.email || '',
  username: u.username || '',
  hasTelegram: !!u.telegram_id,
  hasGoogle: !!u.google_sub
});

// Сесія: випадковий токен у клієнта, у базі лише його хеш
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + ($3 || ' days')::interval)`,
    [sha256(token), userId, String(SESSION_DAYS)]
  );
  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [userId]);
  return token;
}

// Хто робить запит (за заголовком Authorization: Bearer <токен>), або null
async function accountFromRequest(req) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(String(req.headers.authorization || ''));
  if (!m) return null;
  const tokenHash = sha256(m[1]);
  const r = await pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [tokenHash]
  );
  return r.rows[0] ? { user: r.rows[0], tokenHash } : null;
}

async function requireAccount(req, res) {
  const account = await accountFromRequest(req);
  if (!account) res.status(401).json({ success: false, code: 'AUTH', message: 'Увійдіть в акаунт.' });
  return account;
}

let botUsernameCache = (process.env.BOT_USERNAME || '').replace(/^@/, '').trim();
async function getBotUsername() {
  if (botUsernameCache) return botUsernameCache;
  try {
    const me = await bot.getMe();
    if (me && me.username) botUsernameCache = me.username;
  } catch (e) {
    console.error('Не вдалося отримати імʼя бота:', e.message);
  }
  return botUsernameCache || 'priwetabot';
}

const authStartLimit = createLimiter({ windowMs: 10 * 60 * 1000, max: 30, message: TOO_MANY });
const authLoginLimit = createLimiter({ windowMs: 10 * 60 * 1000, max: 20, message: TOO_MANY });

app.get('/api/auth/config', async (req, res) => {
  res.json({ success: true, botUsername: await getBotUsername(), googleClientId: GOOGLE_CLIENT_ID || null });
});

/* ---------- Telegram: сайт видає код, клієнт підтверджує вхід у боті ---------- */
const LOGIN_TTL = 10 * 60 * 1000;
const LOGIN_MAX_PENDING = 5000;
const loginRequests = new Map(); // code -> { secretHash, status, tg, userId, expires }
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of loginRequests) if (r.expires < now) loginRequests.delete(code);
}, 60 * 1000).unref();

const LOGIN_STALE = '⌛ Посилання для входу застаріло. Поверніться на сайт і натисніть «Увійти через Telegram» ще раз.';

app.post('/api/auth/telegram/start', authStartLimit, async (req, res) => {
  if (!authOrigin(req, res)) return;
  const code = crypto.randomBytes(10).toString('hex');   // іде в посилання на бота
  const secret = crypto.randomBytes(24).toString('hex'); // лишається в браузері, яким почали вхід
  if (loginRequests.size >= LOGIN_MAX_PENDING) loginRequests.delete(loginRequests.keys().next().value);
  loginRequests.set(code, { secretHash: sha256(secret), status: 'pending', expires: Date.now() + LOGIN_TTL });
  res.set('Cache-Control', 'no-store');
  res.json({
    success: true, code, secret,
    link: `https://t.me/${await getBotUsername()}?start=login_${code}`,
    expiresIn: LOGIN_TTL / 1000
  });
});

app.post('/api/auth/telegram/poll', async (req, res) => {
  try {
    if (!authOrigin(req, res)) return;
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const code = String(b.code || '');
    const r = /^[0-9a-f]{20}$/.test(code) ? loginRequests.get(code) : null;
    const secretHash = sha256(b.secret || '');
    res.set('Cache-Control', 'no-store');

    if (!r || r.expires < Date.now() ||
        !crypto.timingSafeEqual(Buffer.from(r.secretHash), Buffer.from(secretHash))) {
      return res.json({ success: true, status: 'expired' });
    }
    if (r.status === 'denied') {
      loginRequests.delete(code);
      return res.json({ success: true, status: 'denied' });
    }
    if (r.status !== 'confirmed') {
      return res.json({ success: true, status: 'pending', opened: r.status === 'awaiting' });
    }

    loginRequests.delete(code); // код одноразовий: видаляємо до будь-яких await
    const token = await createSession(r.userId);
    const u = await pool.query('SELECT * FROM users WHERE id = $1', [r.userId]);
    res.json({ success: true, status: 'ok', token, user: publicUser(u.rows[0]) });
  } catch (e) {
    console.error('auth poll:', e.message);
    res.status(500).json({ success: false, message: 'Помилка сервера.' });
  }
});

// Клієнт відкрив у Telegram посилання ...?start=login_<code>
async function handleLoginStart(msg, code) {
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'private' || !msg.from || msg.from.is_bot) return;

  const r = /^[0-9a-f]{20}$/.test(code) ? loginRequests.get(code) : null;
  const takenByOther = r && r.tg && r.tg.id !== msg.from.id;
  if (!r || r.expires < Date.now() || takenByOther || (r.status !== 'pending' && r.status !== 'awaiting')) {
    return bot.sendMessage(chatId, LOGIN_STALE);
  }

  r.status = 'awaiting';
  r.tg = {
    id: msg.from.id,
    name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ').slice(0, 60),
    username: msg.from.username || ''
  };

  // Питаємо явно: якщо посилання людині підсунув хтось інший, вона натисне «Це не я»
  return bot.sendMessage(
    chatId,
    '🔐 Вхід на сайт LEVEL VR CLUB\n\nВи щойно натиснули «Увійти через Telegram» на нашому сайті?\n\n' +
    'Якщо ні, натисніть «Це не я»: можливо, хтось намагається увійти у ваш акаунт.',
    { reply_markup: { inline_keyboard: [[
      { text: '✅ Так, увійти', callback_data: `login_ok_${code}` },
      { text: '❌ Це не я', callback_data: `login_no_${code}` }
    ]] } }
  );
}

async function handleLoginCallback(query) {
  const m = /^login_(ok|no)_([0-9a-f]{20})$/.exec(query.data);
  if (!m || !query.message) return;
  const where = { chat_id: query.message.chat.id, message_id: query.message.message_id };
  const r = loginRequests.get(m[2]);

  if (!r || r.expires < Date.now() || r.status !== 'awaiting' || !r.tg || r.tg.id !== query.from.id) {
    return bot.editMessageText(LOGIN_STALE, where);
  }

  if (m[1] === 'no') {
    r.status = 'denied';
    return bot.editMessageText('❌ Вхід скасовано. У ваш акаунт ніхто не увійшов.', where);
  }

  const u = await pool.query(
    `INSERT INTO users (telegram_id, name, username) VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE
       SET username = EXCLUDED.username, name = COALESCE(NULLIF(users.name, ''), EXCLUDED.name)
     RETURNING *`,
    [String(r.tg.id), r.tg.name, r.tg.username]
  );
  r.userId = u.rows[0].id;
  r.status = 'confirmed';
  await bot.editMessageText('✅ Вхід підтверджено. Поверніться на сайт: кабінет відкриється сам.', where);

  if (!u.rows[0].phone) {
    await bot.sendMessage(
      where.chat_id,
      'Щоб ми могли звʼязатися з вами щодо бронювань, поділіться номером телефону (це потрібно лише один раз).',
      { reply_markup: {
        keyboard: [[{ text: '📱 Поділитися номером', request_contact: true }]],
        resize_keyboard: true, one_time_keyboard: true
      } }
    );
  }
}

// Клієнт натиснув «Поділитися номером»
bot.on('message', async (msg) => {
  if (!msg.contact || !msg.from || msg.chat.type !== 'private') return;
  try {
    if (msg.contact.user_id !== msg.from.id) {
      return bot.sendMessage(msg.chat.id, 'Надішліть, будь ласка, саме свій номер кнопкою «Поділитися номером».');
    }
    const digits = String(msg.contact.phone_number || '').replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) return;
    const r = await pool.query('UPDATE users SET phone = $1 WHERE telegram_id = $2', [`+${digits}`, String(msg.from.id)]);
    if (r.rowCount) {
      await bot.sendMessage(msg.chat.id, '✅ Дякуємо! Номер збережено.', { reply_markup: { remove_keyboard: true } });
    }
  } catch (e) {
    console.error('Помилка збереження номера:', e.message);
  }
});

/* ---------- Google: сайт надсилає ID-токен, сервер перевіряє підпис Google ---------- */
let googleKeys = { byKid: new Map(), expires: 0, fetchedAt: 0 };

async function loadGoogleKeys(force) {
  const now = Date.now();
  if (!force && googleKeys.byKid.size && googleKeys.expires > now) return googleKeys.byKid;
  if (force && now - googleKeys.fetchedAt < 60 * 1000) return googleKeys.byKid; // не частіше ніж раз на хвилину

  const r = await axios.get('https://www.googleapis.com/oauth2/v3/certs', { timeout: 8000 });
  const byKid = new Map();
  for (const jwk of (r.data && r.data.keys) || []) {
    if (jwk.kty === 'RSA' && jwk.kid) byKid.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
  }
  if (!byKid.size) throw new Error('Google не віддав ключі');
  const maxAge = Number((/max-age=(\d+)/.exec((r.headers && r.headers['cache-control']) || '') || [])[1]) || 3600;
  googleKeys = { byKid, expires: now + Math.min(maxAge, 24 * 3600) * 1000, fetchedAt: now };
  return byKid;
}

// Повертає вміст токена або кидає помилку. Перевіряє: підпис, для кого виданий, ким і чи не прострочений.
async function verifyGoogleIdToken(idToken) {
  const raw = String(idToken || '');
  const parts = raw.split('.');
  if (raw.length > 8192 || parts.length !== 3) throw new Error('формат');

  const decode = (p) => JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const header = decode(parts[0]);
  const payload = decode(parts[1]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('алгоритм');

  let key = (await loadGoogleKeys(false)).get(header.kid);
  if (!key) key = (await loadGoogleKeys(true)).get(header.kid); // Google періодично змінює ключі
  if (!key) throw new Error('невідомий ключ');

  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  if (!crypto.verify('RSA-SHA256', signed, key, Buffer.from(parts[2], 'base64url'))) throw new Error('підпис');

  const now = Date.now() / 1000;
  if (payload.aud !== GOOGLE_CLIENT_ID) throw new Error('aud');
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') throw new Error('iss');
  if (!(Number(payload.exp) > now)) throw new Error('прострочений');
  if (payload.nbf && Number(payload.nbf) > now + 60) throw new Error('nbf');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('sub');
  return payload;
}

app.post('/api/auth/google', authLoginLimit, async (req, res) => {
  try {
    if (!authOrigin(req, res)) return;
    if (!GOOGLE_CLIENT_ID) {
      return res.status(503).json({ success: false, message: 'Вхід через Google не налаштовано.' });
    }

    let payload;
    try {
      payload = await verifyGoogleIdToken(req.body && req.body.credential);
    } catch (e) {
      console.warn('Google-вхід відхилено:', e.message);
      return res.status(401).json({ success: false, message: 'Не вдалося підтвердити вхід через Google. Спробуйте ще раз.' });
    }

    // Акаунт шукаємо лише за sub (незмінний ідентифікатор Google), а не за email
    const u = await pool.query(
      `INSERT INTO users (google_sub, email, name) VALUES ($1, $2, $3)
       ON CONFLICT (google_sub) DO UPDATE
         SET email = EXCLUDED.email, name = COALESCE(NULLIF(users.name, ''), EXCLUDED.name)
       RETURNING *`,
      [payload.sub, String(payload.email || '').slice(0, 200), String(payload.name || payload.given_name || '').slice(0, 60)]
    );
    const token = await createSession(u.rows[0].id);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, token, user: publicUser(u.rows[0]) });
  } catch (e) {
    console.error('auth google:', e.message);
    res.status(500).json({ success: false, message: 'Помилка сервера.' });
  }
});

/* ---------- Кабінет ---------- */
app.get('/api/me', async (req, res) => {
  try {
    const account = await requireAccount(req, res);
    if (!account) return;
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, user: publicUser(account.user) });
  } catch (e) {
    console.error('me:', e.message);
    res.status(500).json({ success: false, message: 'Помилка сервера.' });
  }
});

app.get('/api/me/bookings', async (req, res) => {
  try {
    const account = await requireAccount(req, res);
    if (!account) return;

    const r = await pool.query(
      `SELECT id, booking_date, booking_time, total_price, cart_details, confirmed
         FROM bookings WHERE user_id = $1
        ORDER BY booking_date DESC, booking_time DESC LIMIT 100`,
      [account.user.id]
    );

    const today = kyivToday();
    const upcoming = [];
    const past = [];
    for (const b of r.rows) {
      let cart = b.cart_details;
      if (typeof cart === 'string') { try { cart = JSON.parse(cart); } catch { cart = []; } }
      const items = (Array.isArray(cart) ? cart : []).map((i) => ({
        device: String(i.device || ''), duration: Number(i.duration) || 0, price: Number(i.price) || 0
      }));
      const longest = Math.max(1, ...items.map((i) => i.duration));
      const endMin = (toMin(b.booking_time) || 0) + longest * 60;
      const isPast = b.booking_date < today.date || (b.booking_date === today.date && endMin <= today.min);
      (isPast ? past : upcoming).push({
        id: b.id, date: b.booking_date, time: b.booking_time,
        total: Number(b.total_price) || 0, confirmed: !!b.confirmed, items
      });
    }
    upcoming.reverse(); // найближчі зверху

    res.set('Cache-Control', 'no-store');
    res.json({ success: true, upcoming, past });
  } catch (e) {
    console.error('me/bookings:', e.message);
    res.status(500).json({ success: false, message: 'Помилка сервера.' });
  }
});

app.post('/api/me/profile', async (req, res) => {
  try {
    if (!authOrigin(req, res)) return;
    const account = await requireAccount(req, res);
    if (!account) return;

    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    const name = clean(b.name, 60);
    const phone = clean(b.phone, 25);
    const digits = phone.replace(/\D/g, '');

    if (name.length < 2) return res.status(400).json({ success: false, message: 'Вкажіть, будь ласка, ім’я.' });
    if (!/^[+\d\s()\-.]+$/.test(phone) || digits.length < 10 || digits.length > 13) {
      return res.status(400).json({ success: false, message: 'Вкажіть коректний номер телефону.' });
    }

    const u = await pool.query('UPDATE users SET name = $1, phone = $2 WHERE id = $3 RETURNING *', [name, phone, account.user.id]);
    res.json({ success: true, user: publicUser(u.rows[0]) });
  } catch (e) {
    console.error('me/profile:', e.message);
    res.status(500).json({ success: false, message: 'Помилка сервера.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const account = await accountFromRequest(req);
    if (account) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [account.tokenHash]);
    res.json({ success: true });
  } catch (e) {
    console.error('logout:', e.message);
    res.status(500).json({ success: false, message: 'Помилка сервера.' });
  }
});

/* ================= BOOK ================= */
// Екранування для parse_mode HTML: імена/коментарі з сайту можуть містити < > &
const escapeHtml = (v) => String(v ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

app.post('/api/book', bookBurstLimit, bookDailyLimit, async (req, res) => {
  try {
    if (!isAllowedOrigin(req.headers.origin)) {
      return res.status(403).json({ success: false, message: 'Заборонено.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};

    // 1. Приманка для ботів: людина цього прихованого поля не бачить і не заповнює
    if (body.website) {
      console.warn('Спам-бот: заповнене приховане поле, IP', clientIp(req));
      return res.json({ success: true, orderId: 0, claimToken: '' });
    }

    // 2. Токен форми (час, підпис, одноразовість)
    const tokenCheck = checkFormToken(body.formToken);
    if (tokenCheck.error) {
      return res.status(400).json({ success: false, code: 'TOKEN', message: tokenCheck.error });
    }

    // 3. Валідація й очищення даних
    const v = validateBooking(body);
    if (v.error) return res.status(400).json({ success: false, code: 'INVALID', message: v.error });
    const { name, phone, digits, date, time, cart, total, comment } = v.data;

    // Токен «спалюємо» лише після успішної валідації, щоб помилка в полі не вимагала оновлювати сторінку
    usedFormTokens.set(tokenCheck.nonce, Date.now() + FORM_TOKEN_MAX_AGE);

    // 4. Загальна стеля та ліміти на один номер
    if (globalCapReached()) {
      return res.status(429).json({ success: false, code: 'RATE', message: `Зараз дуже багато заявок. ${CALL_US}` });
    }

    const tail = digits.slice(-9);
    const recent = await pool.query(
      `SELECT COUNT(*)::int AS n FROM bookings WHERE ${PHONE_TAIL_SQL} = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [tail]
    );
    if (recent.rows[0].n >= 4) {
      return res.status(429).json({ success: false, code: 'RATE', message: `З цього номера вже створено кілька бронювань. ${CALL_US}` });
    }

    const dup = await pool.query(
      `SELECT id FROM bookings WHERE ${PHONE_TAIL_SQL} = $1 AND booking_date = $2 AND booking_time = $3 LIMIT 1`,
      [tail, date, time]
    );
    if (dup.rows.length) {
      return res.status(409).json({ success: false, code: 'DUPLICATE', message: `Бронювання на цей час для вашого номера вже існує. ${CALL_US}` });
    }

    // 5. Перевірка вільних місць і запис в одній транзакції: блокування по даті не дає
    //    двом клієнтам одночасно зайняти останню приставку.
    //    client_chat_id з запиту НЕ приймаємо: його ставить лише бот за секретним посиланням.
    //    Якщо клієнт увійшов в акаунт, бронювання привʼязується до нього, а Telegram для
    //    нагадувань береться з акаунта (перевірений входом), тож посилання на бота вже не потрібне.
    const account = await accountFromRequest(req).catch(() => null);
    const accountChatId = account && account.user.telegram_id ? account.user.telegram_id : null;

    const claimToken = crypto.randomBytes(8).toString('hex');
    const db = await pool.connect();
    let newId;
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`bookings:${date}`]);

      const dayRows = await loadDayRows(db, date);
      const verdict = evaluateRequest(dayIntervals(dayRows.rows), date, time, cart);
      if (!verdict.ok) {
        await db.query('ROLLBACK');
        return res.status(409).json({
          success: false, code: 'UNAVAILABLE', message: verdict.message, suggestions: verdict.suggestions
        });
      }

      const dbRes = await db.query(
        `INSERT INTO bookings (name, phone, booking_date, booking_time, total_price, cart_details, comment, claim_token, user_id, client_chat_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [name, phone, date, time, total, JSON.stringify(cart), comment, claimToken, account ? account.user.id : null, accountChatId]
      );
      newId = dbRes.rows[0].id;
      await db.query('COMMIT');
    } catch (e) {
      try { await db.query('ROLLBACK'); } catch (_) { /* вже відкочено */ }
      throw e;
    } finally {
      db.release();
    }
    acceptedAt.push(Date.now());

    // Перше бронювання з акаунта без телефону: запамʼятовуємо номер, щоб наступного разу підставити
    if (account && !account.user.phone) {
      pool.query('UPDATE users SET phone = $1 WHERE id = $2', [phone, account.user.id]).catch(() => {});
    }

    let tgMsg = `<b>👾 НОВЕ ЗАМОВЛЕННЯ #${newId}!</b>\n\n`;
    tgMsg += `👤 <b>Ім'я:</b> ${escapeHtml(name)}\n`;
    tgMsg += `📞 <b>Телефон:</b> <code>${escapeHtml(phone)}</code>\n`;
    tgMsg += `📅 <b>Дата:</b> ${escapeHtml(date)}\n`;
    tgMsg += `⏰ <b>Час:</b> ${escapeHtml(time)}\n\n`;
    tgMsg += `🛒 <b>ЗАМОВЛЕННЯ:</b>\n`;

    cart.forEach((item, idx) => {
      tgMsg += `${idx + 1}. ${escapeHtml(item.device)} (${escapeHtml(item.duration)} год + 5 хв 🎁) — ${escapeHtml(item.price)} грн\n`;
    });

    tgMsg += `\n💰 <b>ЗАГАЛОМ: ${escapeHtml(total)} грн</b>`;
    if (comment !== 'Немає') tgMsg += `\n\n💬 <b>Коментар:</b> <i>${escapeHtml(comment)}</i>`;
    tgMsg += `\n\n⏳ <b>СТАТУС: ОЧІКУЄ ПІДТВЕРДЖЕННЯ</b>`;

    // Бронювання вже збережене: якщо Telegram тимчасово не відповів, клієнту не показуємо помилку
    // (інакше він відправить форму ще раз і створить дубль)
    try {
      await bot.sendMessage(ADMIN_CHAT_ID, tgMsg, {
        parse_mode: 'HTML',
        reply_markup: bookingKeyboard(newId, false)
      });
    } catch (e) {
      console.error(`Не вдалося сповістити адміна про замовлення #${newId}:`, e.message);
    }

    res.json({ success: true, orderId: newId, claimToken, botLinked: !!accountChatId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: `Помилка сервера. Спробуйте пізніше. ${CALL_US}` });
  }
});

/* ================= CANCEL FLOW ================= */
const cancelReasons = {};

/* ================= CALLBACK ================= */
bot.on('callback_query', async (query) => {
  // Кнопки підтвердження входу на сайт (натискає сам клієнт у своєму чаті з ботом)
  if (typeof query.data === 'string' && query.data.startsWith('login_')) {
    try {
      await handleLoginCallback(query);
    } catch (e) {
      console.error('Помилка підтвердження входу:', e.message);
    }
    return bot.answerCallbackQuery(query.id).catch(() => {});
  }

  const action = query.data; // ВАЖЛИВО: Оголошуємо action!
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const orderId = action.split('_')[1];

  try {
    if (action.startsWith('confirm_')) {
      const res = await pool.query(
        'UPDATE bookings SET confirmed = TRUE WHERE id = $1 RETURNING client_chat_id, booking_time', [orderId]
      );
      
      if (res.rows[0]?.client_chat_id) {
        await bot.sendMessage(res.rows[0].client_chat_id, `✅ Замовлення #${orderId} підтверджено на ${res.rows[0].booking_time}!`);
      }

      const updatedText = query.message.text.replace('⏳ СТАТУС: ОЧІКУЄ ПІДТВЕРДЖЕННЯ', '✅ СТАТУС: ПІДТВЕРДЖЕНО');
      await bot.editMessageText(updatedText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        // після підтвердження лишаємо кнопки "Перенести" і "Скасувати"
        reply_markup: bookingKeyboard(orderId, true)
      });
    } 
    else if (action.startsWith('cancel_')) {
      delete moveState[chatId];
      cancelReasons[chatId] = orderId;
      bot.sendMessage(chatId, `❌ Введіть причину скасування для #${orderId}:`);
    }
    else if (action.startsWith('move_')) {
      if (isAdmin(chatId)) {
        await startMove(chatId, orderId, {
          chatId,
          messageId,
          text: query.message.text
        });
      }
    }
  } catch (e) {
    console.error("Помилка кнопок:", e);
  }
  bot.answerCallbackQuery(query.id);
});


/* ================= REASON ================= */
bot.on('message', async (msg) => {
  const adminId = msg.chat.id;

  if (!cancelReasons[adminId]) return;
  if (!isAdmin(adminId)) return;

  const id = cancelReasons[adminId];
  const reason = msg.text;

  const res = await pool.query('SELECT client_chat_id FROM bookings WHERE id=$1', [id]);

  if (res.rows[0]?.client_chat_id) {
    bot.sendMessage(res.rows[0].client_chat_id, `❌ Замовлення #${id} скасовано\nПричина: ${reason}`);
  }

  await pool.query('DELETE FROM bookings WHERE id=$1', [id]);

  bot.sendMessage(adminId, `❌ Скасовано #${id}`);
  delete cancelReasons[adminId];
});

/* ================= MOVE (ПЕРЕНЕСЕННЯ БРОНЮВАННЯ) ================= */
// chatId адміна -> { id, source }, поки бот чекає нову дату/час
const moveState = {};

const pad2 = (n) => String(n).padStart(2, '0');

// Поточний час у Києві (сервер може жити в UTC)
function kyivNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
}

// 2026-11-05 -> 05.11.2026 (для людей); інші формати лишаємо як є
function fmtDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (d || '—');
}

// Кнопки під повідомленням про замовлення
function bookingKeyboard(id, confirmed) {
  const move = { text: '🔄 Перенести', callback_data: `move_${id}` };
  const cancel = { text: '❌ Скасувати', callback_data: `cancel_${id}` };
  const confirm = { text: '✅ Підтвердити', callback_data: `confirm_${id}` };

  return {
    inline_keyboard: confirmed ? [[move, cancel]] : [[confirm, cancel], [move]]
  };
}

// Розбирає "07.11.2026 16:00", "2026-11-07", "16:00", "07.11" ...
// Повертає { date, time } (кожне може бути null) або { error }
function parseMoveInput(input, now) {
  let date = null;
  let time = null;

  for (const token of String(input).trim().split(/\s+/)) {
    if (token.includes(':')) {
      const tm = /^(\d{1,2}):(\d{2})$/.exec(token);
      if (!tm) return { error: `Не розумію час "${token}". Формат: 16:00` };
      const hh = Number(tm[1]);
      const mm = Number(tm[2]);
      if (hh > 23 || mm > 59) return { error: `Некоректний час "${token}"` };
      time = `${pad2(hh)}:${pad2(mm)}`;
      continue;
    }

    let y, mo, d;
    let dm;
    if ((dm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(token))) {
      y = Number(dm[1]); mo = Number(dm[2]); d = Number(dm[3]);
    } else if ((dm = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(token))) {
      d = Number(dm[1]); mo = Number(dm[2]); y = Number(dm[3]);
    } else if ((dm = /^(\d{1,2})\.(\d{1,2})$/.exec(token))) {
      d = Number(dm[1]); mo = Number(dm[2]); y = now.getFullYear();
    } else {
      return { error: `Не розумію "${token}". Приклади: 07.11.2026 або 16:00` };
    }

    const check = new Date(y, mo - 1, d);
    if (check.getFullYear() !== y || check.getMonth() !== mo - 1 || check.getDate() !== d) {
      return { error: `Такої дати не існує: "${token}"` };
    }
    date = `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  if (!date && !time) return { error: 'Вкажіть нову дату та/або час.' };
  return { date, time };
}

// Переносить бронювання. true = готово (або безнадійно), false = чекаємо виправлений ввід
async function applyMove(adminChatId, id, rawInput, source) {
  // «!» у кінці = перенести попри нестачу місць
  const force = /(^|\s)!(?=\s|$)/.test(rawInput);
  const input = String(rawInput).replace(/(^|\s)!(?=\s|$)/g, ' ').trim();
  const found = await pool.query('SELECT * FROM bookings WHERE id=$1', [id]);
  const b = found.rows[0];
  if (!b) {
    await bot.sendMessage(adminChatId, `❌ Замовлення #${id} не знайдено.`);
    return true;
  }

  const now = kyivNow();
  const parsed = parseMoveInput(input, now);
  if (parsed.error) {
    await bot.sendMessage(adminChatId, `❌ ${parsed.error}`);
    return false;
  }

  const newDate = parsed.date || b.booking_date;
  const newTime = parsed.time || b.booking_time;

  if (newDate === b.booking_date && newTime === b.booking_time) {
    await bot.sendMessage(adminChatId, 'ℹ️ Це вже поточні дата й час. Надішліть інші.');
    return false;
  }

  const [y, mo, d] = String(newDate).split('-').map(Number);
  const [hh, mm] = String(newTime || '00:00').split(':').map(Number);
  if (new Date(y, mo - 1, d, hh, mm) < now) {
    await bot.sendMessage(adminChatId, '❌ Цей час уже минув. Вкажіть дату й час у майбутньому.');
    return false;
  }

  // Чи вистачає обладнання на новий час (саме це бронювання з розрахунку виключаємо)
  if (!force) {
    const day = await pool.query(
      'SELECT booking_time, cart_details FROM bookings WHERE booking_date = $1 AND id <> $2', [newDate, id]
    );
    let cart = b.cart_details;
    if (typeof cart === 'string') { try { cart = JSON.parse(cart); } catch { cart = []; } }
    const verdict = evaluateRequest(dayIntervals(day.rows), newDate, newTime, Array.isArray(cart) ? cart : []);
    if (!verdict.ok) {
      await bot.sendMessage(adminChatId, `⚠️ ${verdict.message}\n\nЩоб перенести все одно, надішліть ту саму дату/час із «!» в кінці, наприклад: ${fmtDate(newDate)} ${newTime} !`);
      return false;
    }
  }

  await pool.query(
    'UPDATE bookings SET booking_date=$1, booking_time=$2 WHERE id=$3',
    [newDate, newTime, id]
  );

  const oldStr = `${fmtDate(b.booking_date)} ${b.booking_time}`;
  const newStr = `${fmtDate(newDate)} ${newTime}`;

  // Повідомляємо клієнта (якщо він підключений до бота)
  let clientNote;
  if (b.client_chat_id) {
    try {
      await bot.sendMessage(
        b.client_chat_id,
        `🔄 Ваше замовлення #${id} у LEVEL VR CLUB перенесено.\n\n❌ Було: ${oldStr}\n✅ Тепер: ${newStr}`
      );
      clientNote = '📨 Клієнту надіслано повідомлення.';
    } catch (e) {
      clientNote = `⚠️ Не вдалося написати клієнту. Повідомте вручну: ${b.name}, ${b.phone}`;
    }
  } else {
    clientNote = `ℹ️ Клієнт не підключений до бота. Повідомте вручну: ${b.name}, ${b.phone}`;
  }

  await bot.sendMessage(adminChatId, `✅ Замовлення #${id} перенесено\n${oldStr} → ${newStr}\n\n${clientNote}`);

  // Якщо перенесення почали з кнопки — оновлюємо оригінальне повідомлення
  if (source && source.text) {
    try {
      const confirmed = source.text.includes('ПІДТВЕРДЖЕНО');
      const newText = source.text
        .replace(/📅 Дата:.*/, `📅 Дата: ${newDate}`)
        .replace(/⏰ Час:.*/, `⏰ Час: ${newTime}`);
      await bot.editMessageText(newText, {
        chat_id: source.chatId,
        message_id: source.messageId,
        reply_markup: bookingKeyboard(id, confirmed)
      });
    } catch (e) {
      console.error('Не вдалося оновити повідомлення замовлення:', e.message);
    }
  }

  return true;
}

// Починає діалог: бот просить нову дату/час
async function startMove(chatId, id, source) {
  const res = await pool.query('SELECT name, booking_date, booking_time FROM bookings WHERE id=$1', [id]);
  const b = res.rows[0];
  if (!b) return bot.sendMessage(chatId, `❌ Замовлення #${id} не знайдено.`);

  delete cancelReasons[chatId];
  moveState[chatId] = { id, source };

  return bot.sendMessage(
    chatId,
    `🔄 Перенесення замовлення #${id} (${b.name})\n` +
    `Зараз: ${fmtDate(b.booking_date)} ${b.booking_time}\n\n` +
    `Надішліть нову дату і/або час, наприклад:\n` +
    `• 07.11.2026 16:00\n` +
    `• 16:00 (тільки час)\n` +
    `• 07.11 (тільки дата)\n\n` +
    `/stop — скасувати перенесення`
  );
}

// /move            — підказка
// /move 12         — бот запитає нову дату/час
// /move 12 07.11 16:00 — перенести одразу
bot.onText(/^\/move(?:@\w+)?(?:\s+(\d+))?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  const id = match[1];
  const input = match[2];

  if (!id) {
    return bot.sendMessage(
      chatId,
      '🔄 Перенесення бронювання:\n\n' +
      '/move 12 — бот запитає нову дату і час\n' +
      '/move 12 07.11.2026 16:00 — перенести одразу\n' +
      '/move 12 16:00 — змінити лише час\n' +
      '/move 12 07.11 — змінити лише дату\n\n' +
      'Номери замовлень видно в /today та в повідомленнях про замовлення. ' +
      'Також можна натиснути кнопку «🔄 Перенести» під замовленням.'
    );
  }

  try {
    if (input) {
      delete moveState[chatId];
      delete cancelReasons[chatId];
      await applyMove(chatId, id, input, null);
    } else {
      await startMove(chatId, id, null);
    }
  } catch (e) {
    console.error('Помилка /move:', e);
    bot.sendMessage(chatId, '❌ Помилка під час перенесення.');
  }
});

// Відповідь адміна з новою датою/часом (після кнопки або /move <id>)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const state = moveState[chatId];
  if (!state || !isAdmin(chatId) || !msg.text) return;

  if (msg.text.startsWith('/')) {
    if (/^\/move/i.test(msg.text)) return; // новий /move сам розбереться зі станом
    delete moveState[chatId];
    if (/^\/(stop|cancel)/i.test(msg.text)) {
      bot.sendMessage(chatId, '↩️ Перенесення скасовано.');
    }
    return;
  }

  try {
    const done = await applyMove(chatId, state.id, msg.text, state.source);
    if (done) delete moveState[chatId];
  } catch (e) {
    console.error('Помилка перенесення:', e);
    bot.sendMessage(chatId, '❌ Помилка під час перенесення.');
    delete moveState[chatId];
  }
});

/* ================= REMINDER ================= */
cron.schedule('* * * * *', async () => {
  // Отримуємо поточний час у часовому поясі Києва (щоб уникнути багів з UTC на сервері)
  const kyivTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  
  // Формуємо сьогоднішню дату у форматі YYYY-MM-DD
  const todayStr = kyivTime.getFullYear() + '-' + 
                   String(kyivTime.getMonth() + 1).padStart(2, '0') + '-' + 
                   String(kyivTime.getDate()).padStart(2, '0');
                   
  const currentMinutes = kyivTime.getHours() * 60 + kyivTime.getMinutes();

  // Шукаємо замовлення ТІЛЬКИ на сьогоднішню дату
  const res = await pool.query('SELECT * FROM bookings WHERE booking_date=$1', [todayStr]);

  res.rows.forEach(b => {
    if (!b.booking_time) return;
    
    const [h, m] = b.booking_time.split(':');
    const bookingMinutes = parseInt(h) * 60 + parseInt(m);

    // Якщо до гри рівно 60 хвилин і є chat_id клієнта
    if (bookingMinutes - currentMinutes === 60 && b.client_chat_id) {
      bot.sendMessage(b.client_chat_id, `🔔 Нагадування: ваша гра в LEVEL VR CLUB почнеться о ${b.booking_time}!`);
    }
  });
});

/* ================= MONITOR ================= */
let isDown = false;

cron.schedule('*/5 * * * *', async () => {
  try {
    await axios.get(SITE_URL);
    isDown = false;
  } catch {
    if (!isDown) {
      isDown = true;
      bot.sendMessage(OWNER_CHAT_ID, '❌ Сайт впав');
    }
  }
});

/* ================= OWNER ================= */
bot.onText(/\/status/, async (msg) => {
  if (!isOwner(msg.chat.id)) return;

  try {
    await pool.query('SELECT 1');
    bot.sendMessage(msg.chat.id, '✅ Все працює');
  } catch {
    bot.sendMessage(msg.chat.id, '❌ БД проблема');
  }
});

bot.onText(/\/online/, (msg) => {
  if (!isOwner(msg.chat.id)) return;
  bot.sendMessage(msg.chat.id, `👥 Онлайн: ${onlineUsers}`);
});

/* ================= ERRORS ================= */
process.on('uncaughtException', (err) => {
  bot.sendMessage(OWNER_CHAT_ID, `💥 ${err.message}`);
});

process.on('unhandledRejection', (err) => {
  bot.sendMessage(OWNER_CHAT_ID, `⚠️ ${err}`);
});

/* ================= START ================= */
server.listen(PORT, () => {
  console.log(`🚀 Server ${PORT}`);
  bot.sendMessage(OWNER_CHAT_ID, `🚀 Сервер запущено`);
});

/* ================= ADMIN GAMES MANAGEMENT ================= */
// Інструкція для адміна
bot.onText(/\/addgame/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  
  const text = `🎮 *Додавання нової гри*\n\n` +
               `Відправте повідомлення у такому форматі (розділяючи знаком |):\n\n` +
               `\`+гра | Платформа | Назва | Опис | Посилання на фото\`\n\n` +
               `*Приклад:*\n` +
               `\`+гра | PS5 | UFC 5 | Симулятор бойових мистецтв... | https://link.to/img.jpg\``;
               
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});


// Обробка повідомлення з новою грою (АВТОМАТИЧНО ЧЕРЕЗ IGDB)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!isAdmin(chatId) || !text) return;

    if (text.toLowerCase().startsWith('+додати ')) {
        const gameName = text.replace('+додати ', '').trim();
        
        try {
            bot.sendMessage(chatId, `🔍 Шукаю <b>${gameName}</b> у базі IGDB...`, { parse_mode: 'HTML' });

            const token = await getIgdbToken();
            if (!token) return bot.sendMessage(chatId, "❌ Помилка авторизації IGDB. Перевірте ключі в Render.");

            const response = await axios({
                url: 'https://api.igdb.com/v4/games',
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Client-ID': TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${token}`
                },
                data: `search "${gameName}"; fields name, summary, platforms.name, cover.url; limit 1;`
            });

            if (response.data.length === 0) {
                return bot.sendMessage(chatId, "❌ Гру не знайдено. Спробуйте точнішу назву англійською.");
            }

            const game = response.data[0];
            
            let imageUrl = "https://via.placeholder.com/500x700?text=No+Image";
            if (game.cover && game.cover.url) {
                imageUrl = 'https:' + game.cover.url.replace('t_thumb', 't_1080p');
            }

            const description = game.summary || "Опис відсутній.";
            
            const platforms = game.platforms ? game.platforms.map(p => p.name).join(', ') : "Невідомо";
            let mainPlatform = 'Console';
            if (platforms.includes('PlayStation 5')) mainPlatform = 'PS5';
            else if (platforms.includes('PlayStation 4')) mainPlatform = 'PS4';
            else if (platforms.includes('PC')) mainPlatform = 'PC';
            else if (platforms.includes('VR')) mainPlatform = 'VR';

            await pool.query(
                'INSERT INTO games (title, platform, description, image_url) VALUES ($1, $2, $3, $4)',
                [game.name, mainPlatform, description.substring(0, 500) + '...', imageUrl]
            );

            bot.sendPhoto(chatId, imageUrl, {
                caption: `✅ <b>Гру автоматично додано!</b>\n\n🎮 <b>Назва:</b> ${game.name}\n🕹 <b>Платформи:</b> ${platforms}\n\n<i>Вона вже з'явилася на сайті.</i>`,
                parse_mode: 'HTML'
            });

        } catch (err) {
            console.error("Помилка IGDB:", err.response ? err.response.data : err.message);
            if (err.response && err.response.status === 401) igdbAccessToken = null; 
            bot.sendMessage(chatId, "❌ Сталася помилка при зверненні до бази ігор.");
        }
    }
});

/* ================= GAMES ROUTE ================= */
app.get('/api/games', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM games ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Помилка завантаження ігор' });
  }
});
/* ================= ERRORS ================= */
// Завжди JSON і без технічних подробиць для відвідувача
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Запит занадто великий.' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ success: false, message: 'Некоректний запит.' });
  }
  console.error(err);
  res.status(500).json({ success: false, message: 'Помилка сервера.' });
});