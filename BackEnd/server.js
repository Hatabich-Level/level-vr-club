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
// Картинки й шрифти браузер тримає тиждень; HTML, CSS і JS щоразу звіряє з сервером (ETag)
app.use(express.static(path.join(__dirname, '../FrondEnd'), {
  setHeaders(res, filePath) {
    if (/\.(?:png|jpe?g|webp|avif|gif|svg|ico|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  }
}));

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
  // Бонуси і запрошення друзів
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_code TEXT UNIQUE`);
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER`);
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_state TEXT`);
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_warned_at TIMESTAMP`);
  await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS bonus_used INTEGER DEFAULT 0`);
  // Старі бронювання лишаються з NULL: бали за візити до запуску бонусів не нараховуються
  await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS bonus_state TEXT`);
  await client.query(`ALTER TABLE bookings ALTER COLUMN bonus_state SET DEFAULT 'new'`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS bonus_tx (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      kind TEXT NOT NULL,
      booking_id INTEGER,
      note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_bonus_tx_user ON bonus_tx (user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users (referred_by)`);
  // Нотатки адміна про клієнта (клієнт = останні 9 цифр телефону)
  await client.query(`
    CREATE TABLE IF NOT EXISTS client_notes (
      phone_tail TEXT PRIMARY KEY,
      note TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

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
  
  // Скільки разів переклад опису гри не вдався (щоб не пробувати безкінечно)
  await client.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS translate_tries INTEGER DEFAULT 0`);

  client.release();
})();


/* ================= GAMES HELPERS ================= */
async function gameExistsByTitle(title) {
  if (!title) return false;
  const result = await pool.query(
    'SELECT id FROM games WHERE LOWER(TRIM(title)) = LOWER(TRIM($1)) LIMIT 1',
    [String(title)]
  );
  return result.rows.length > 0;
}

// Лапки й зворотні слеші в назві не мають ламати запит до IGDB
function escapeIgdbQuery(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Наскільки назва гри з IGDB відповідає введеному запиту. Менше значення = кращий збіг.
function scoreGameMatch(name, query) {
  const n = (name || '').toLowerCase().trim();
  const q = (query || '').toLowerCase().trim();
  if (!n || !q) return 99;
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(q)) return 2;

  const qTokens = q.split(/\s+/).filter(Boolean);
  const overlap = qTokens.filter(t => n.includes(t)).length;
  return 10 - overlap;
}

function sortGamesByRelevance(list, query, nameField = 'name') {
  return [...list].sort(
    (a, b) => scoreGameMatch(a[nameField], query) - scoreGameMatch(b[nameField], query)
  );
}

// Пошук у IGDB: повертає ігри, відсортовані за схожістю назви. Кидає помилку 'IGDB_AUTH', якщо немає токена.
async function searchIgdb(query, limit) {
  const token = await getIgdbToken();
  if (!token) throw new Error('IGDB_AUTH');

  try {
    const response = await axios({
      url: 'https://api.igdb.com/v4/games',
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Client-ID': TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`
      },
      data: `search "${escapeIgdbQuery(query)}"; fields name, summary, platforms.name, cover.url; limit ${limit};`
    });
    return sortGamesByRelevance(Array.isArray(response.data) ? response.data : [], query, 'name');
  } catch (err) {
    if (err.response && err.response.status === 401) igdbAccessToken = null; // токен прострочився: наступного разу візьмемо новий
    throw err;
  }
}

// Запис IGDB -> гра для нашого каталогу. image_url порожній, якщо обкладинки немає (сайт покаже заглушку).
function igdbToGame(game) {
  const platformsFull = game.platforms ? game.platforms.map(p => p.name).join(', ') : 'Невідомо';
  let platform = 'Console';
  if (platformsFull.includes('PlayStation 5')) platform = 'PS5';
  else if (platformsFull.includes('PlayStation 4')) platform = 'PS4';
  else if (platformsFull.includes('PC')) platform = 'PC';
  else if (platformsFull.includes('VR')) platform = 'VR';

  const summary = String(game.summary || 'Опис відсутній.');
  return {
    title: String(game.name || '').trim(),
    platform,
    platformsFull,
    description: summary.length > 500 ? summary.substring(0, 500) + '...' : summary,
    image_url: game.cover && game.cover.url ? 'https:' + game.cover.url.replace('t_thumb', 't_1080p') : ''
  };
}

/* ================= ПЕРЕКЛАД ОПИСІВ ІГОР УКРАЇНСЬКОЮ ================= */
// IGDB віддає описи англійською. Перекладаємо їх безкоштовним сервісом MyMemory:
// без реєстрації до 5000 символів на добу, з поштою в TRANSLATE_EMAIL до 50000.
// Якщо переклад недоступний, опис лишається англійською, а фонова задача спробує пізніше.
const TRANSLATE_EMAIL = (process.env.TRANSLATE_EMAIL || '').trim();
const TRANSLATE_MAX_TRIES = 3;
const hasCyrillic = (t) => /[А-Яа-яІіЇїЄєҐґ]/.test(String(t || ''));

const decodeEntities = (t) => String(t)
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Сервіс приймає до 500 байт за запит: ріжемо текст по реченнях, а надто довгі речення по словах
function splitForTranslate(text, maxBytes = 450) {
  const bytes = (v) => Buffer.byteLength(v, 'utf8');
  const parts = [];
  let cur = '';
  const push = (piece) => {
    if (!piece) return;
    const next = cur ? `${cur} ${piece}` : piece;
    if (bytes(next) <= maxBytes) { cur = next; return; }
    if (cur) { parts.push(cur); cur = ''; }
    if (bytes(piece) <= maxBytes) { cur = piece; return; }
    for (const word of piece.split(/\s+/)) {
      const w = bytes(word) > maxBytes ? Buffer.from(word, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/�+$/, '') : word;
      const n = cur ? `${cur} ${w}` : w;
      if (bytes(n) <= maxBytes) cur = n; else { parts.push(cur); cur = w; }
    }
  };
  String(text).split(/(?<=[.!?])\s+/).forEach(push);
  if (cur) parts.push(cur);
  return parts;
}

// Повертає { text } або { error: 'skip' | 'unavailable' | 'bad' }
//  skip        — перекладати нічого (порожньо або вже українською)
//  unavailable — сервіс не відповів або вичерпано добовий ліміт: варто спробувати пізніше
//  bad         — сервіс відповів, але українського тексту не дав
async function translateToUk(text) {
  const src = String(text || '').trim();
  if (!src || hasCyrillic(src)) return { error: 'skip' };

  const out = [];
  for (const part of splitForTranslate(src)) {
    let data;
    try {
      const r = await axios.get('https://api.mymemory.translated.net/get', {
        params: { q: part, langpair: 'en|uk', ...(TRANSLATE_EMAIL ? { de: TRANSLATE_EMAIL } : {}) },
        timeout: 8000
      });
      data = r.data || {};
    } catch (e) {
      return { error: 'unavailable' };
    }
    const t = data.responseData && data.responseData.translatedText;
    if (Number(data.responseStatus) !== 200 || typeof t !== 'string' || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(t)) {
      return { error: 'unavailable' };
    }
    out.push(decodeEntities(t).trim());
  }

  const joined = out.join(' ').replace(/\s+/g, ' ').trim();
  if (!joined || !hasCyrillic(joined)) return { error: 'bad' };
  return { text: joined.slice(0, 800) };
}

// Фонова задача: потроху перекладає описи ігор, які досі англійською (старі ігри або день без ліміту)
let translatingGames = false;
async function translatePendingGames(limit = 5) {
  if (translatingGames) return { translated: 0, left: null };
  translatingGames = true;
  let translated = 0;
  try {
    const rows = await pool.query(
      `SELECT id, description FROM games
        WHERE COALESCE(description, '') <> '' AND description !~ '[А-Яа-яІіЇїЄєҐґ]' AND COALESCE(translate_tries, 0) < $1
        ORDER BY id DESC LIMIT $2`,
      [TRANSLATE_MAX_TRIES, limit]
    );
    for (const g of rows.rows) {
      const r = await translateToUk(g.description);
      if (r.text) {
        // опис міг змінитися, поки ми перекладали: оновлюємо лише якщо він той самий
        const u = await pool.query('UPDATE games SET description = $1 WHERE id = $2 AND description = $3', [r.text, g.id, g.description]);
        translated += u.rowCount;
      } else if (r.error === 'unavailable') {
        break; // ліміт або збій сервісу: наступна спроба за годину
      } else {
        await pool.query('UPDATE games SET translate_tries = COALESCE(translate_tries, 0) + 1 WHERE id = $1', [g.id]);
      }
    }
  } catch (e) {
    console.error('Помилка перекладу описів ігор:', e.message);
  } finally {
    translatingGames = false;
  }
  return { translated };
}
cron.schedule('17 * * * *', () => { translatePendingGames(); });
setTimeout(() => { translatePendingGames(); }, 60 * 1000).unref(); // і одразу після запуску сервера

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
bot.onText(/^\/clear(?:@\w+)?\s*$/i, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  // Бали, списані на ігри, які ще не відбулися, повертаємо клієнтам
  const withBonus = await pool.query(`SELECT * FROM bookings WHERE bonus_used > 0 AND bonus_state = 'new'`);
  for (const b of withBonus.rows) await refundBookingBonus(b);
  await pool.query('TRUNCATE bookings RESTART IDENTITY');
  bot.sendMessage(msg.chat.id, '🧹 Базу очищено');
});

bot.onText(/^\/today(?:@\w+)?\s*$/i, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;

  // Дата за київським часом: сервер працює в UTC, і після півночі показував би вчорашній день
  const today = kyivToday().date;
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
  hasGoogle: !!u.google_sub,
  isAdmin: isSiteAdmin(u)
});

// Хто бачить адмін-панель на сайті: власник (OWNER_CHAT_ID — особистий Telegram) і,
// за бажанням, інші люди зі списків SITE_ADMIN_TELEGRAM_IDS / SITE_ADMIN_EMAILS (через кому).
// ADMIN_CHAT_ID — це група, тому вона сюди не входить.
const listEnv = (v) => String(v || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
const SITE_ADMIN_TG = new Set([OWNER_CHAT_ID, ...listEnv(process.env.SITE_ADMIN_TELEGRAM_IDS)]
  .map((x) => String(x || '').trim()).filter((x) => /^\d+$/.test(x)));
const SITE_ADMIN_EMAILS = new Set(listEnv(process.env.SITE_ADMIN_EMAILS).map((x) => x.toLowerCase()));
function isSiteAdmin(u) {
  if (!u) return false;
  if (u.telegram_id && SITE_ADMIN_TG.has(String(u.telegram_id))) return true;
  return !!(u.google_sub && u.email && SITE_ADMIN_EMAILS.has(String(u.email).toLowerCase()));
}

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
      [payload.sub, (payload.email_verified === true || payload.email_verified === 'true') ? String(payload.email || '').slice(0, 200) : '', String(payload.name || payload.given_name || '').slice(0, 60)]
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
      `SELECT id, booking_date, booking_time, total_price, cart_details, confirmed, bonus_used
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
        total: Number(b.total_price) || 0, confirmed: !!b.confirmed, items, bonusUsed: Number(b.bonus_used) || 0
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
    // Оплата балами: лише з акаунтом і не для дня народження (там своя ціна, бонусів немає)
    const wantsBonus = body.useBonus === true && !!account && !isBirthdayCart(cart);
    let bonusUsed = 0;

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

      if (wantsBonus) {
        // Блокуємо рядок клієнта: два одночасні бронювання не спишуть ті самі бали двічі
        await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [account.user.id]);
        const balance = await bonusBalance(db, account.user.id);
        bonusUsed = Math.max(0, Math.min(balance, Math.floor(total * BONUS.maxShare / 100)));
      }

      const dbRes = await db.query(
        `INSERT INTO bookings (name, phone, booking_date, booking_time, total_price, cart_details, comment, claim_token, user_id, client_chat_id, bonus_used)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [name, phone, date, time, total, JSON.stringify(cart), comment, claimToken, account ? account.user.id : null, accountChatId, bonusUsed]
      );
      newId = dbRes.rows[0].id;
      if (bonusUsed > 0) {
        await addBonusTx(db, account.user.id, -bonusUsed, 'spend', newId, `Оплата бронювання на ${fmtDate(date).slice(0, 5)}`);
      }
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
    if (bonusUsed > 0) tgMsg += `\n🎁 <b>Оплачено балами:</b> ${bonusUsed} грн\n💵 <b>До сплати в клубі: ${total - bonusUsed} грн</b>`;
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

    res.json({ success: true, orderId: newId, claimToken, botLinked: !!accountChatId, bonusUsed, toPay: total - bonusUsed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: `Помилка сервера. Спробуйте пізніше. ${CALL_US}` });
  }
});

/* ================= CANCEL FLOW ================= */
const cancelReasons = {};
// chatId адміна -> гра, знайдена командою «+додати», яка чекає на «Так/Ні»
const pendingGameAdds = {};

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

  const action = String(query.data || '');
  const ack = (text) => bot.answerCallbackQuery(query.id, text ? { text } : undefined).catch(() => {});

  // Дуже старі повідомлення Telegram надсилає без query.message
  if (!query.message) return ack('Повідомлення застаріло');

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  if (!isAdmin(chatId)) return ack();

  try {
    /* ---- підтвердження гри, знайденої командою «+додати» ---- */
    if (action === 'gameadd_yes' || action === 'gameadd_no') {
      // Повідомлення з обкладинкою редагується як підпис, без обкладинки як текст
      const edit = (text) => (query.message.photo
        ? bot.editMessageCaption(text, { chat_id: chatId, message_id: messageId })
        : bot.editMessageText(text, { chat_id: chatId, message_id: messageId }));

      const pending = pendingGameAdds[chatId];
      // Кнопка під старим повідомленням не має додати гру, знайдену пізнішим пошуком
      if (!pending || pending.messageId !== messageId) {
        return ack('Немає активної гри для додавання');
      }
      delete pendingGameAdds[chatId];

      if (action === 'gameadd_no') {
        await edit('❌ Додавання гри скасовано. Спробуйте ввести точнішу назву.');
      } else if (await gameExistsByTitle(pending.title)) {
        await edit(`⚠️ Гра "${pending.title}" вже є в каталозі. Пропущено.`);
      } else {
        const tr = await translateToUk(pending.description);
        await pool.query(
          'INSERT INTO games (title, platform, description, image_url) VALUES ($1, $2, $3, $4)',
          [pending.title, pending.platform, tr.text || pending.description, pending.image_url]
        );
        await edit(`✅ Гру "${pending.title}" додано на сайт!` +
          (tr.text || tr.error === 'skip' ? '' : '\n\nОпис поки англійською: переклад зараз недоступний, сервер спробує ще раз пізніше.'));
      }
      return ack();
    }

    const orderId = action.split('_')[1];

    if (action.startsWith('confirm_')) {
      const res = await pool.query(
        'UPDATE bookings SET confirmed = TRUE WHERE id = $1 RETURNING client_chat_id, booking_time', [orderId]
      );

      if (res.rows[0]?.client_chat_id) {
        // Клієнт міг заблокувати бота: це не має заважати підтвердженню
        await bot.sendMessage(res.rows[0].client_chat_id, `✅ Замовлення #${orderId} підтверджено на ${res.rows[0].booking_time}!`)
          .catch((e) => console.error(`Не вдалося написати клієнту про #${orderId}:`, e.message));
      }

      const updatedText = String(query.message.text || '').replace('⏳ СТАТУС: ОЧІКУЄ ПІДТВЕРДЖЕННЯ', '✅ СТАТУС: ПІДТВЕРДЖЕНО');
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
      await bot.sendMessage(chatId, `❌ Введіть причину скасування для #${orderId}:\n\n/stop — не скасовувати`);
    }
    else if (action.startsWith('move_')) {
      await startMove(chatId, orderId, {
        chatId,
        messageId,
        text: query.message.text
      });
    }
  } catch (e) {
    console.error("Помилка кнопок:", e);
  }
  ack();
});


/* ================= REASON ================= */
bot.on('message', async (msg) => {
  const adminId = msg.chat.id;

  if (!cancelReasons[adminId]) return;
  if (!isAdmin(adminId)) return;

  const id = cancelReasons[adminId];

  // Команда замість причини = адмін передумав скасовувати
  if (typeof msg.text === 'string' && msg.text.startsWith('/')) {
    delete cancelReasons[adminId];
    if (/^\/(stop|cancel)/i.test(msg.text)) {
      bot.sendMessage(adminId, `↩️ Замовлення #${id} не скасовано.`).catch(() => {});
    }
    return;
  }
  // Фото, стікер тощо: причини немає, чекаємо текст
  if (typeof msg.text !== 'string' || !msg.text.trim()) {
    bot.sendMessage(adminId, `Напишіть причину скасування для #${id} текстом або /stop, щоб не скасовувати.`).catch(() => {});
    return;
  }

  const reason = msg.text.trim();
  delete cancelReasons[adminId];

  try {
    const res = await pool.query('DELETE FROM bookings WHERE id=$1 RETURNING *', [id]);
    if (!res.rows.length) {
      await bot.sendMessage(adminId, `ℹ️ Замовлення #${id} вже видалено раніше.`);
      return;
    }
    await refundBookingBonus(res.rows[0]);

    if (res.rows[0].client_chat_id) {
      await bot.sendMessage(res.rows[0].client_chat_id, `❌ Замовлення #${id} скасовано\nПричина: ${reason}`)
        .catch((e) => console.error(`Не вдалося написати клієнту про скасування #${id}:`, e.message));
    }

    await bot.sendMessage(adminId, `❌ Скасовано #${id}`);
  } catch (e) {
    console.error('Помилка скасування:', e);
    bot.sendMessage(adminId, `❌ Не вдалося скасувати #${id}. Спробуйте ще раз.`).catch(() => {});
  }
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
  try {
    // Київський час (сервер працює в UTC)
    const now = kyivToday();

    // Замовлення ТІЛЬКИ на сьогодні й лише ті, де є кому писати
    const res = await pool.query(
      'SELECT booking_time, client_chat_id FROM bookings WHERE booking_date=$1 AND client_chat_id IS NOT NULL',
      [now.date]
    );

    for (const b of res.rows) {
      const bookingMinutes = toMin(b.booking_time);
      if (bookingMinutes === null) continue;

      // До гри рівно 60 хвилин
      if (bookingMinutes - now.min === 60) {
        bot.sendMessage(b.client_chat_id, `🔔 Нагадування: ваша гра в LEVEL VR CLUB почнеться о ${b.booking_time}!`)
          .catch((e) => console.error('Не вдалося надіслати нагадування:', e.message));
      }
    }
  } catch (e) {
    console.error('Помилка нагадувань:', e.message);
  }
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
      bot.sendMessage(OWNER_CHAT_ID, '❌ Сайт впав').catch(() => {});
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
// .catch обовʼязковий: якщо саме це повідомлення не дійде (Telegram недоступний, невірний
// OWNER_CHAT_ID), помилка відправки знову потрапила б сюди, і так по колу
process.on('uncaughtException', (err) => {
  console.error('Критична помилка:', err);
  bot.sendMessage(OWNER_CHAT_ID, `💥 ${err.message}`).catch(() => {});
});

process.on('unhandledRejection', (err) => {
  bot.sendMessage(OWNER_CHAT_ID, `⚠️ ${err}`).catch(() => {});
});

/* ================= START ================= */
server.listen(PORT, () => {
  console.log(`🚀 Server ${PORT}`);
  bot.sendMessage(OWNER_CHAT_ID, `🚀 Сервер запущено`).catch(() => {});
});

/* ================= ADMIN GAMES MANAGEMENT ================= */
// Інструкція для адміна
bot.onText(/^\/addgame(?:@\w+)?\s*$/i, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;

  const text = '🎮 <b>Додавання нової гри</b>\n\n' +
               'Надішліть назву гри (краще англійською) у такому форматі:\n\n' +
               '<code>+додати UFC 5</code>\n\n' +
               'Бот знайде гру, покаже обкладинку і запитає, чи це вона. ' +
               'Додати або видалити гру можна і на сайті, на сторінці каталогу ігор.';

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' }).catch(() => {});
});

// «+додати Назва»: шукаємо гру в IGDB і питаємо підтвердження, перш ніж додати на сайт
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!isAdmin(chatId) || !text) return;

  const m = /^\+додати\s+(.+)$/i.exec(text.trim());
  if (!m) return;
  const gameName = m[1].trim();

  try {
    await bot.sendMessage(chatId, `🔍 Шукаю <b>${escapeHtml(gameName)}</b> у базі IGDB...`, { parse_mode: 'HTML' });

    let found;
    try {
      found = await searchIgdb(gameName, 10);
    } catch (e) {
      if (e.message === 'IGDB_AUTH') {
        return bot.sendMessage(chatId, '❌ Помилка авторизації IGDB. Перевірте ключі в Render.');
      }
      throw e;
    }

    if (found.length === 0) {
      return bot.sendMessage(chatId, '❌ Гру не знайдено. Спробуйте точнішу назву англійською.');
    }

    // Найсхожіша за назвою, а не випадковий перший варіант з IGDB
    const game = igdbToGame(found[0]);

    // ЗАХИСТ ВІД ДУБЛІКАТІВ
    if (await gameExistsByTitle(game.title)) {
      return bot.sendMessage(chatId, `⚠️ Гра <b>${escapeHtml(game.title)}</b> вже є в каталозі. Пропущено, щоб не дублювати.`, { parse_mode: 'HTML' });
    }

    const caption = `❓ <b>Це та гра?</b>\n\n🎮 <b>Назва:</b> ${escapeHtml(game.title)}\n🕹 <b>Платформи:</b> ${escapeHtml(game.platformsFull)}\n\n` +
      '<i>Перевірте назву. Якщо це не та гра, натисніть «Ні» і спробуйте ввести точнішу назву (бажано англійською).</i>';
    const options = {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Так, додати', callback_data: 'gameadd_yes' },
          { text: '❌ Ні, скасувати', callback_data: 'gameadd_no' }
        ]]
      }
    };

    // Гру НЕ вставляємо в базу одразу: вона чекає на кнопку «Так»
    const sent = game.image_url
      ? await bot.sendPhoto(chatId, game.image_url, { caption, ...options })
      : await bot.sendMessage(chatId, caption, options);

    pendingGameAdds[chatId] = {
      title: game.title,
      platform: game.platform,
      description: game.description,
      image_url: game.image_url,
      messageId: sent && sent.message_id
    };
  } catch (err) {
    console.error('Помилка IGDB:', err.response ? err.response.data : err.message);
    bot.sendMessage(chatId, '❌ Сталася помилка при зверненні до бази ігор.').catch(() => {});
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

/* ================= КЕРУВАННЯ ІГРАМИ ЧЕРЕЗ САЙТ (без Telegram) ================= */
const SITE_ADMIN_KEY = process.env.SITE_ADMIN_KEY;

// Захист від підбору ключа: 10 невдалих спроб з однієї адреси за 15 хвилин
const KEY_FAIL_WINDOW = 15 * 60 * 1000;
const KEY_FAIL_MAX = 10;
const keyFails = new Map(); // ip -> [час невдалих спроб]
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of keyFails) {
    const fresh = arr.filter((t) => now - t < KEY_FAIL_WINDOW);
    if (fresh.length) keyFails.set(ip, fresh); else keyFails.delete(ip);
  }
}, 60 * 1000).unref();

// Повертає тіло запиту, якщо це адмін (увійшов на сайті) або ключ вірний;
// інакше сам відповідає помилкою і повертає null
async function siteAdminBody(req, res) {
  if (!isAllowedOrigin(req.headers.origin)) {
    res.status(403).json({ error: 'Заборонено' });
    return null;
  }

  // Адмін, що увійшов через Telegram/Google, ключа не вводить
  if (req.headers.authorization) {
    try {
      const account = await accountFromRequest(req);
      if (account && isSiteAdmin(account.user)) {
        req.siteAdmin = account.user;
        return req.body && typeof req.body === 'object' ? req.body : {};
      }
    } catch (e) {
      console.error('Перевірка адміна (ігри):', e.message);
      res.status(500).json({ error: 'Помилка сервера' });
      return null;
    }
  }

  const ip = clientIp(req);
  const now = Date.now();
  const fails = (keyFails.get(ip) || []).filter((t) => now - t < KEY_FAIL_WINDOW);
  if (fails.length >= KEY_FAIL_MAX) {
    res.status(429).json({ error: 'Забагато невдалих спроб. Спробуйте за 15 хвилин.' });
    return null;
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const given = typeof body.key === 'string' ? body.key : '';
  const ok = !!SITE_ADMIN_KEY && !!given &&
    crypto.timingSafeEqual(Buffer.from(sha256(given)), Buffer.from(sha256(SITE_ADMIN_KEY)));

  if (!ok) {
    fails.push(now);
    keyFails.set(ip, fails);
    res.status(403).json({ error: 'Невірний ключ доступу' });
    return null;
  }
  return body;
}

// Пошук ігор у IGDB прямо з сайту (повертає кілька варіантів на вибір)
app.post('/api/games/search-site', async (req, res) => {
  const body = await siteAdminBody(req, res);
  if (!body) return;

  const query = String(body.query || '').trim().slice(0, 100);
  if (!query) {
    return res.status(400).json({ error: 'Введіть назву гри' });
  }

  try {
    const found = await searchIgdb(query, 8);
    const results = await Promise.all(found.map(async (raw) => {
      const game = igdbToGame(raw);
      return { ...game, exists: await gameExistsByTitle(game.title) };
    }));
    res.json(results);
  } catch (err) {
    if (err.message === 'IGDB_AUTH') return res.status(500).json({ error: 'Помилка авторизації IGDB' });
    console.error('Помилка пошуку IGDB (сайт):', err.response ? err.response.data : err.message);
    res.status(500).json({ error: 'Помилка пошуку гри' });
  }
});

// Додавання обраної гри з сайту (з повторною перевіркою дублікатів)
app.post('/api/games/add-site', async (req, res) => {
  const body = await siteAdminBody(req, res);
  if (!body) return;

  const game = body.game && typeof body.game === 'object' ? body.game : {};
  const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
  const title = clean(game.title, 200);
  if (!title) {
    return res.status(400).json({ error: 'Немає даних гри' });
  }
  // Картинка лише за https-посиланням: інакше в каталог можна було б підкласти шкідливу адресу
  const imageUrl = clean(game.image_url, 500);
  if (imageUrl && !/^https:\/\/[^\s"'<>]+$/i.test(imageUrl)) {
    return res.status(400).json({ error: 'Некоректне посилання на обкладинку' });
  }

  try {
    if (await gameExistsByTitle(title)) {
      return res.status(409).json({ error: 'Ця гра вже є в каталозі' });
    }

    const description = clean(game.description, 800);
    const tr = await translateToUk(description);

    const result = await pool.query(
      'INSERT INTO games (title, platform, description, image_url) VALUES ($1, $2, $3, $4) RETURNING *',
      [title, clean(game.platform, 40) || 'Console', tr.text || description, imageUrl]
    );

    if (ADMIN_CHAT_ID) {
      bot.sendMessage(ADMIN_CHAT_ID, `🎮 Гру "${title}" додано через сайт${req.siteAdmin ? ' — ' + adminWho({ user: req.siteAdmin }) : ''}.`).catch(() => {});
    }

    // translated: false = опис лишився англійською (сервер спробує перекласти пізніше)
    res.json({ success: true, game: result.rows[0], translated: !!tr.text || tr.error === 'skip' });
  } catch (err) {
    console.error('Помилка додавання гри (сайт):', err.message);
    res.status(500).json({ error: 'Помилка додавання гри' });
  }
});

// Зміна опису гри вручну (наприклад, щоб поправити автоматичний переклад)
app.post('/api/games/update-site', async (req, res) => {
  const body = await siteAdminBody(req, res);
  if (!body) return;

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Немає id гри' });
  }
  const description = String(body.description ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800);
  if (!description) {
    return res.status(400).json({ error: 'Опис не може бути порожнім' });
  }

  try {
    // translate_tries на максимум: текст, який написав адмін, автоматичний переклад більше не чіпає
    const result = await pool.query(
      'UPDATE games SET description = $1, translate_tries = $2 WHERE id = $3 RETURNING *',
      [description, TRANSLATE_MAX_TRIES, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Гру не знайдено' });
    }
    res.json({ success: true, game: result.rows[0] });
  } catch (err) {
    console.error('Помилка зміни опису (сайт):', err.message);
    res.status(500).json({ error: 'Помилка збереження опису' });
  }
});

// Видалення гри з каталогу через сайт
app.post('/api/games/delete-site', async (req, res) => {
  const body = await siteAdminBody(req, res);
  if (!body) return;

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Немає id гри' });
  }

  try {
    const result = await pool.query('DELETE FROM games WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Гру не знайдено' });
    }

    if (ADMIN_CHAT_ID) {
      bot.sendMessage(ADMIN_CHAT_ID, `🗑 Гру "${result.rows[0].title}" видалено через сайт${req.siteAdmin ? ' — ' + adminWho({ user: req.siteAdmin }) : ''}.`).catch(() => {});
    }

    res.json({ success: true, game: result.rows[0] });
  } catch (err) {
    console.error('Помилка видалення гри (сайт):', err.message);
    res.status(500).json({ error: 'Помилка видалення гри' });
  }
});

/* ================= ERRORS ================= */
// Завжди JSON і без технічних подробиць для відвідувача

/* ================= АДМІН-ПАНЕЛЬ НА САЙТІ ================= */
async function requireSiteAdmin(req, res) {
  const account = await requireAccount(req, res);
  if (!account) return null;
  if (!isSiteAdmin(account.user)) {
    res.status(403).json({ success: false, code: 'NOT_ADMIN', message: 'Немає доступу.' });
    return null;
  }
  res.set('Cache-Control', 'no-store');
  return account;
}

const parseCart = (cart) => {
  if (typeof cart === 'string') { try { cart = JSON.parse(cart); } catch { cart = []; } }
  return (Array.isArray(cart) ? cart : []).map((i) => ({
    device: String(i.device || ''), duration: Number(i.duration) || 0, price: Number(i.price) || 0,
    persons: Number(i.persons) || undefined
  }));
};
const phoneTail = (phone) => String(phone || '').replace(/\D/g, '').slice(-9);
const adminWho = (account) => account.user.name || (account.user.username ? '@' + account.user.username : 'адмін');

// Тихо повідомляємо групу адмінів, щоб там бачили дії, зроблені на сайті
const tellGroup = (text) => (ADMIN_CHAT_ID
  ? bot.sendMessage(ADMIN_CHAT_ID, text).catch((e) => console.error('Не вдалося написати в групу:', e.message))
  : Promise.resolve());
const tellClient = async (chatId, text) => {
  if (!chatId) return false;
  try { await bot.sendMessage(chatId, text); return true; } catch (e) { return false; }
};

function adminBooking(b) {
  return {
    id: b.id, name: b.name || '', phone: b.phone || '', tail: phoneTail(b.phone),
    date: b.booking_date, time: b.booking_time, total: Number(b.total_price) || 0,
    confirmed: !!b.confirmed, comment: b.comment && b.comment !== 'Немає' ? b.comment : '',
    items: parseCart(b.cart_details), botLinked: !!b.client_chat_id,
    username: b.username || '', source: b.telegram_id ? 'tg' : (b.google_sub ? 'google' : ''),
    bonusUsed: Number(b.bonus_used) || 0, bonusState: b.bonus_state || '', hasAccount: !!b.user_id
  };
}

app.get('/api/admin/overview', async (req, res) => {
  try {
    if (!(await requireSiteAdmin(req, res))) return;
    const today = kyivToday().date;
    const month = today.slice(0, 7);
    const [list, stats] = await Promise.all([
      // + вчорашні підтверджені ігри клієнтів з акаунтом: до нарахування балів ще можна позначити «Не прийшов»
      pool.query(
        `SELECT b.*, u.username, u.telegram_id, u.google_sub
           FROM bookings b LEFT JOIN users u ON u.id = b.user_id
          WHERE b.booking_date >= $1
             OR (b.booking_date = $2 AND b.user_id IS NOT NULL AND b.bonus_state = 'new' AND COALESCE(b.confirmed, FALSE))
          ORDER BY b.booking_date, b.booking_time, b.id LIMIT 300`, [today, shiftDate(today, -1)]),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE booking_date = $1)::int AS today,
           COUNT(*) FILTER (WHERE booking_date >= $1 AND NOT COALESCE(confirmed, FALSE))::int AS pending,
           COALESCE(SUM(total_price) FILTER (WHERE booking_date LIKE $2 || '-%'), 0)::float AS month_sum,
           COUNT(DISTINCT ${PHONE_TAIL_SQL})::int AS clients
         FROM bookings`, [today, month])
    ]);
    const st = stats.rows[0];
    res.json({
      success: true, today,
      stats: { today: st.today, pending: st.pending, clients: st.clients, monthSum: Math.round(st.month_sum), month },
      bookings: list.rows.map(adminBooking)
    });
  } catch (e) {
    console.error('admin/overview:', e.message);
    res.status(500).json({ success: false, message: 'Помилка сервера.' });
  }
});

app.get('/api/admin/clients', async (req, res) => {
  try {
    if (!(await requireSiteAdmin(req, res))) return;
    const today = kyivToday().date;
    const r = await pool.query(
      `WITH c AS (
         SELECT ${PHONE_TAIL_SQL} AS tail,
                (array_agg(name ORDER BY created_at DESC))[1] AS name,
                (array_agg(phone ORDER BY created_at DESC))[1] AS phone,
                COUNT(*) FILTER (WHERE booking_date <= $1)::int AS visits,
                COUNT(*) FILTER (WHERE booking_date > $1)::int AS upcoming,
                COALESCE(SUM(total_price) FILTER (WHERE booking_date <= $1), 0)::float AS spent,
                MIN(booking_date) AS first_date,
                MAX(booking_date) FILTER (WHERE booking_date <= $1) AS last_date,
                MAX(user_id) AS user_id
           FROM bookings GROUP BY 1
       )
       SELECT c.*, u.username, u.telegram_id, u.google_sub, n.note,
              (SELECT COALESCE(SUM(amount), 0) FROM bonus_tx t WHERE t.user_id = c.user_id)::int AS bonus
         FROM c LEFT JOIN users u ON u.id = c.user_id
                LEFT JOIN client_notes n ON n.phone_tail = c.tail
        WHERE c.tail <> ''
        ORDER BY c.last_date DESC NULLS LAST, c.first_date DESC LIMIT 3000`, [today]);
    res.json({
      success: true, today,
      clients: r.rows.map((c) => ({
        tail: c.tail, name: c.name || '', phone: c.phone || '', visits: c.visits, upcoming: c.upcoming,
        spent: Math.round(c.spent), first: c.first_date, last: c.last_date || '',
        username: c.username || '', source: c.telegram_id ? 'tg' : (c.google_sub ? 'google' : ''),
        note: c.note || '', bonus: c.user_id ? c.bonus : null
      }))
    });
  } catch (e) {
    console.error('admin/clients:', e.message);
    res.status(500).json({ success: false, message: 'Помилка сервера.' });
  }
});

app.get('/api/admin/client', async (req, res) => {
  try {
    if (!(await requireSiteAdmin(req, res))) return;
    const tail = String(req.query.tail || '');
    if (!/^\d{9}$/.test(tail)) return res.status(400).json({ success: false, message: 'Некоректний клієнт.' });
    const [list, note] = await Promise.all([
      pool.query(
        `SELECT b.*, u.username, u.telegram_id, u.google_sub
           FROM bookings b LEFT JOIN users u ON u.id = b.user_id
          WHERE ${PHONE_TAIL_SQL.replace('phone', 'b.phone')} = $1
          ORDER BY b.booking_date DESC, b.booking_time DESC LIMIT 200`, [tail]),
      pool.query('SELECT note FROM client_notes WHERE phone_tail = $1', [tail])
    ]);
    const userId = (list.rows.find((b) => b.user_id) || {}).user_id || null;
    let bonus = null;
    if (userId) {
      const [bal, tx] = await Promise.all([
        bonusBalance(pool, userId),
        pool.query('SELECT amount, kind, note, created_at FROM bonus_tx WHERE user_id = $1 ORDER BY id DESC LIMIT 20', [userId])
      ]);
      bonus = { userId, balance: bal, history: tx.rows.map(txOut) };
    }
    res.json({ success: true, bookings: list.rows.map(adminBooking), note: note.rows[0] ? note.rows[0].note : '', bonus });
  } catch (e) {
    console.error('admin/client:', e.message);
    res.status(500).json({ success: false, message: 'Помилка сервера.' });
  }
});

app.post('/api/admin/client/note', async (req, res) => {
  try {
    if (!authOrigin(req, res)) return;
    if (!(await requireSiteAdmin(req, res))) return;
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const tail = String(b.tail || '');
    if (!/^\d{9}$/.test(tail)) return res.status(400).json({ success: false, message: 'Некоректний клієнт.' });
    const note = String(b.note ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, 1000);
    await pool.query(
      `INSERT INTO client_notes (phone_tail, note, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (phone_tail) DO UPDATE SET note = EXCLUDED.note, updated_at = NOW()`, [tail, note]);
    res.json({ success: true, note });
  } catch (e) {
    console.error('admin/note:', e.message);
    res.status(500).json({ success: false, message: 'Помилка сервера.' });
  }
});

const bookingIdFrom = (b) => (/^\d{1,9}$/.test(String(b && b.id)) ? Number(b.id) : null);

app.post('/api/admin/booking/confirm', async (req, res) => {
  try {
    if (!authOrigin(req, res)) return;
    const account = await requireSiteAdmin(req, res);
    if (!account) return;
    const id = bookingIdFrom(req.body);
    if (!id) return res.status(400).json({ success: false, message: 'Некоректне бронювання.' });
    const r = await pool.query('UPDATE bookings SET confirmed = TRUE WHERE id = $1 RETURNING *', [id]);
    const b = r.rows[0];
    if (!b) return res.status(404).json({ success: false, message: 'Бронювання вже немає (його могли скасувати).' });
    const told = await tellClient(b.client_chat_id, `✅ Замовлення #${id} підтверджено на ${b.booking_time}!`);
    tellGroup(`✅ #${id} (${b.name}, ${fmtDate(b.booking_date)} ${b.booking_time}) підтверджено на сайті — ${adminWho(account)}`);
    res.json({ success: true, clientNotified: told });
  } catch (e) {
    console.error('admin/confirm:', e.message);
    res.status(500).json({ success: false, message: 'Помилка сервера.' });
  }
});

app.post('/api/admin/booking/cancel', async (req, res) => {
  try {
    if (!authOrigin(req, res)) return;
    const account = await requireSiteAdmin(req, res);
    if (!account) return;
    const id = bookingIdFrom(req.body);
    const reason = String((req.body && req.body.reason) ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 300);
    if (!id) return res.status(400).json({ success: false, message: 'Некоректне бронювання.' });
    if (reason.length < 2) return res.status(400).json({ success: false, message: 'Вкажіть причину скасування.' });
    const r = await pool.query('DELETE FROM bookings WHERE id = $1 RETURNING *', [id]);
    const b = r.rows[0];
    if (!b) return res.status(404).json({ success: false, message: 'Бронювання вже скасоване.' });
    await refundBookingBonus(b);
    const told = await tellClient(b.client_chat_id, `❌ Замовлення #${id} скасовано\nПричина: ${reason}`);
    tellGroup(`❌ #${id} (${b.name}, ${b.phone}, ${fmtDate(b.booking_date)} ${b.booking_time}) скасовано на сайті — ${adminWho(account)}\nПричина: ${reason}` +
      (told ? '' : '\nℹ️ Клієнт не підключений до бота: повідомте його вручну.'));
    res.json({ success: true, clientNotified: told });
  } catch (e) {
    console.error('admin/cancel:', e.message);
    res.status(500).json({ success: false, message: 'Помилка сервера.' });
  }
});

app.post('/api/admin/booking/move', async (req, res) => {
  try {
    if (!authOrigin(req, res)) return;
    const account = await requireSiteAdmin(req, res);
    if (!account) return;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const id = bookingIdFrom(body);
    if (!id) return res.status(400).json({ success: false, message: 'Некоректне бронювання.' });
    const date = String(body.date || '');
    const time = String(body.time || '');
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const tm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
    if (!dm || !tm) return res.status(400).json({ success: false, message: 'Вкажіть дату й час.' });
    const [y, mo, d] = [dm[1], dm[2], dm[3]].map(Number);
    const when = new Date(y, mo - 1, d, Number(tm[1]), Number(tm[2]));
    if (when.getMonth() !== mo - 1 || when.getDate() !== d) return res.status(400).json({ success: false, message: 'Такої дати не існує.' });
    if (when < kyivNow()) return res.status(400).json({ success: false, message: 'Цей час уже минув.' });

    const found = await pool.query('SELECT * FROM bookings WHERE id = $1', [id]);
    const b = found.rows[0];
    if (!b) return res.status(404).json({ success: false, message: 'Бронювання вже немає.' });
    if (b.booking_date === date && b.booking_time === time) {
      return res.status(400).json({ success: false, message: 'Це вже поточні дата й час.' });
    }

    const cart = parseCart(b.cart_details);
    const startMin = toMin(time);
    const longest = Math.max(1, ...cart.map((i) => i.duration));
    if (startMin < OPEN_MIN || startMin + longest * 60 > CLOSE_MIN) {
      return res.status(400).json({ success: false, message: `Клуб працює з 10:00 до 22:00. Для ${longest} год найпізніший початок — ${22 - longest}:00.` });
    }

    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`bookings:${date}`]);
      if (!body.force) {
        const day = await db.query('SELECT booking_time, cart_details FROM bookings WHERE booking_date = $1 AND id <> $2', [date, id]);
        const verdict = evaluateRequest(dayIntervals(day.rows), date, time, cart);
        if (!verdict.ok) {
          await db.query('ROLLBACK');
          return res.status(409).json({ success: false, code: 'UNAVAILABLE', message: verdict.message, suggestions: verdict.suggestions || [] });
        }
      }
      await db.query('UPDATE bookings SET booking_date = $1, booking_time = $2 WHERE id = $3', [date, time, id]);
      await db.query('COMMIT');
    } catch (e) {
      try { await db.query('ROLLBACK'); } catch (_) { /* вже відкочено */ }
      throw e;
    } finally {
      db.release();
    }

    const oldStr = `${fmtDate(b.booking_date)} ${b.booking_time}`;
    const newStr = `${fmtDate(date)} ${time}`;
    const told = await tellClient(b.client_chat_id,
      `🔄 Ваше замовлення #${id} у LEVEL VR CLUB перенесено.\n\n❌ Було: ${oldStr}\n✅ Тепер: ${newStr}`);
    tellGroup(`🔄 #${id} (${b.name}, ${b.phone}) перенесено на сайті — ${adminWho(account)}\n${oldStr} → ${newStr}` +
      (told ? '' : '\nℹ️ Клієнт не підключений до бота: повідомте його вручну.'));
    res.json({ success: true, clientNotified: told });
  } catch (e) {
    console.error('admin/move:', e.message);
    res.status(500).json({ success: false, message: 'Помилка сервера.' });
  }
});


/* ================= БОНУСИ І ЗАПРОШЕННЯ ДРУЗІВ ================= */
// Правила можна змінити змінними на Render, не чіпаючи код
const envInt = (name, def, min, max) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : def;
};
const BONUS = {
  percent: envInt('BONUS_PERCENT', 3, 0, 50),         // % від суми, сплаченої грошима
  maxShare: envInt('BONUS_MAX_SHARE', 50, 0, 100),     // скільки % гри можна оплатити балами
  referral: envInt('BONUS_REFERRAL', 50, 0, 10000),   // за друга — і другу, і тому, хто запросив
  welcome: envInt('BONUS_WELCOME', 50, 0, 10000),     // за першу гру
  expireDays: envInt('BONUS_EXPIRE_DAYS', 365, 30, 3650), // згорають, якщо стільки днів не було візитів
  warnDays: 30,                                        // за скільки днів попередити
  refMonthly: 10                                       // скільки друзів на місяць винагороджуємо
};
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function isBirthdayCart(cart) {
  return parseCart(cart).some((i) => /^День народження/i.test(i.device));
}
function shiftDate(date, days) {
  const [y, m, d] = String(date).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}
async function bonusBalance(q, userId) {
  const r = await q.query('SELECT COALESCE(SUM(amount), 0)::int AS b FROM bonus_tx WHERE user_id = $1', [userId]);
  return r.rows[0].b;
}
function addBonusTx(q, userId, amount, kind, bookingId, note) {
  return q.query('INSERT INTO bonus_tx (user_id, amount, kind, booking_id, note) VALUES ($1, $2, $3, $4, $5)',
    [userId, Math.trunc(amount), kind, bookingId || null, String(note || '').slice(0, 200)]);
}
const txOut = (t) => ({ amount: t.amount, kind: t.kind, note: t.note || '', at: t.created_at });
const tellUser = (user, text) => (user && user.telegram_id
  ? bot.sendMessage(user.telegram_id, text).catch(() => {}) : Promise.resolve());
const firstName = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Друг';
  return parts[0] + (parts[1] ? ' ' + parts[1][0] + '.' : '');
};

// Бронювання скасували або клієнт не прийшов: повертаємо списані бали (один раз)
async function refundBookingBonus(b) {
  try {
    if (!b || !b.user_id || !(Number(b.bonus_used) > 0)) return;
    // created_at: після /clear номери бронювань починаються спочатку, тож дивимось лише записи цього бронювання
    const q = (kind) => pool.query(
      `SELECT 1 FROM bonus_tx WHERE booking_id = $1 AND kind = $2 AND user_id = $3 AND created_at >= $4 LIMIT 1`,
      [b.id, kind, b.user_id, b.created_at]);
    const already = await q('refund');
    const spent = await q('spend');
    if (already.rows.length || !spent.rows.length) return;
    await addBonusTx(pool, b.user_id, Number(b.bonus_used), 'refund', b.id, `Повернення: бронювання на ${fmtDate(b.booking_date).slice(0, 5)} скасовано`);
  } catch (e) {
    console.error('Повернення балів:', e.message);
  }
}

// Нарахування за ігри, які відбулися. Адмін може до обіду наступного дня позначити «Не прийшов».
async function creditVisits() {
  const now = kyivToday();
  const yesterday = shiftDate(now.date, -1);
  const lastDay = kyivNow().getHours() >= 12 ? yesterday : shiftDate(now.date, -2);

  // Непідтверджені ігри без руху два тижні: закриваємо, щоб не перевіряти щоразу
  await pool.query(`UPDATE bookings SET bonus_state = 'skipped' WHERE bonus_state = 'new' AND booking_date < $1 AND NOT COALESCE(confirmed, FALSE)`, [shiftDate(now.date, -14)]);
  await pool.query(`UPDATE bookings SET bonus_state = 'guest' WHERE bonus_state = 'new' AND user_id IS NULL AND booking_date <= $1`, [lastDay]);

  const due = await pool.query(
    `SELECT id FROM bookings WHERE bonus_state = 'new' AND user_id IS NOT NULL AND COALESCE(confirmed, FALSE)
        AND booking_date <= $1 ORDER BY booking_date, id LIMIT 500`, [lastDay]);
  for (const { id } of due.rows) {
    const notes = [];
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const r = await db.query(`UPDATE bookings SET bonus_state = 'done' WHERE id = $1 AND bonus_state = 'new' RETURNING *`, [id]);
      const b = r.rows[0];
      if (!b) { await db.query('ROLLBACK'); continue; }
      const u = (await db.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [b.user_id])).rows[0];
      if (!u) { await db.query('COMMIT'); continue; }
      if (isBirthdayCart(b.cart_details)) {
        await db.query(`UPDATE bookings SET bonus_state = 'birthday' WHERE id = $1`, [id]);
        await db.query('COMMIT');
        continue;
      }
      const day = fmtDate(b.booking_date).slice(0, 5);
      const items = parseCart(b.cart_details).map((i) => `${i.device}, ${i.duration} год`).join(' + ');
      const paid = Math.max(0, (Number(b.total_price) || 0) - (Number(b.bonus_used) || 0));
      const earn = Math.floor(paid * BONUS.percent / 100);
      let got = 0;
      if (earn > 0) { await addBonusTx(db, u.id, earn, 'earn', id, `Гра ${day} · ${items} (${paid} грн)`); got += earn; }

      const welcomed = await db.query(`SELECT 1 FROM bonus_tx WHERE user_id = $1 AND kind = 'welcome' LIMIT 1`, [u.id]);
      if (!welcomed.rows.length && BONUS.welcome > 0) {
        await addBonusTx(db, u.id, BONUS.welcome, 'welcome', id, 'Вітальні — за першу гру в клубі');
        got += BONUS.welcome;
      }

      // Запрошений друг прийшов уперше
      if (u.referred_by && u.referral_state === 'pending') {
        // Другом вважаємо лише новий номер: якщо з нього бронювали ще до реєстрації, винагороди немає
        const tail = phoneTail(b.phone);
        const before = await db.query(
          `SELECT 1 FROM bookings WHERE ${PHONE_TAIL_SQL} = $1 AND created_at < $2 AND id <> $3 LIMIT 1`, [tail, u.created_at, id]);
        const inviter = (await db.query('SELECT * FROM users WHERE id = $1', [u.referred_by])).rows[0];
        if (before.rows.length || !inviter) {
          await db.query(`UPDATE users SET referral_state = 'rejected' WHERE id = $1`, [u.id]);
        } else {
          await db.query(`UPDATE users SET referral_state = 'rewarded' WHERE id = $1`, [u.id]);
          if (BONUS.referral > 0) {
            await addBonusTx(db, u.id, BONUS.referral, 'ref_friend', id, `Бонус за запрошення від ${firstName(inviter.name)}`);
            got += BONUS.referral;
            const month = await db.query(
              `SELECT COUNT(*)::int AS n FROM bonus_tx WHERE user_id = $1 AND kind = 'ref_inviter' AND created_at > NOW() - INTERVAL '30 days'`, [inviter.id]);
            if (month.rows[0].n < BONUS.refMonthly) {
              await addBonusTx(db, inviter.id, BONUS.referral, 'ref_inviter', id, `Друг ${firstName(u.name)} прийшов на першу гру`);
              notes.push([inviter, `🎉 Ваш друг ${firstName(u.name)} прийшов у LEVEL VR CLUB! Вам нараховано ${BONUS.referral} балів.`]);
            }
          }
        }
      }
      await db.query('COMMIT');
      if (got > 0) {
        const bal = await bonusBalance(pool, u.id);
        notes.push([u, `🎁 +${got} балів за гру ${day} у LEVEL VR CLUB. На рахунку: ${bal} балів (1 бал = 1 грн).`]);
      }
    } catch (e) {
      try { await db.query('ROLLBACK'); } catch (_) { /* вже відкочено */ }
      console.error(`Нарахування балів #${id}:`, e.message);
      continue;
    } finally {
      db.release();
    }
    for (const [user, text] of notes) await tellUser(user, text);
  }
}

// Бали згорають, якщо довго не було візитів; за місяць попереджаємо
async function expireBonuses() {
  const r = await pool.query(
    `WITH s AS (
       SELECT user_id, SUM(amount)::int AS bal,
              MAX(created_at) FILTER (WHERE amount > 0 AND kind <> 'refund') AS last_act
         FROM bonus_tx GROUP BY user_id
     )
     SELECT s.*, u.telegram_id, u.bonus_warned_at FROM s JOIN users u ON u.id = s.user_id
      WHERE s.bal > 0 AND s.last_act < NOW() - make_interval(days => $1)`,
    [BONUS.expireDays - BONUS.warnDays]);
  for (const x of r.rows) {
    const expiresAt = new Date(new Date(x.last_act).getTime() + BONUS.expireDays * 86400000);
    if (expiresAt <= new Date()) {
      await addBonusTx(pool, x.user_id, -x.bal, 'expire', null, `Згоріли: ${BONUS.expireDays} днів без візитів`);
    } else if (!x.bonus_warned_at || new Date(x.bonus_warned_at) < new Date(x.last_act)) {
      await pool.query('UPDATE users SET bonus_warned_at = NOW() WHERE id = $1', [x.user_id]);
      const d = expiresAt.toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' });
      await tellUser(x, `⏳ У вас ${x.bal} балів у LEVEL VR CLUB. Вони згорять ${d}, якщо до того часу не прийти на гру. Чекаємо вас!`);
    }
  }
}

let bonusJobRunning = false;
async function bonusJob() {
  if (bonusJobRunning) return;
  bonusJobRunning = true;
  try {
    await creditVisits();
    await expireBonuses();
  } catch (e) {
    console.error('Бонуси (щогодини):', e.message);
  } finally {
    bonusJobRunning = false;
  }
}
cron.schedule('41 * * * *', bonusJob);

async function ensureRefCode(user) {
  if (user.ref_code) return user.ref_code;
  for (let i = 0; i < 8; i++) {
    const code = Array.from(crypto.randomBytes(6), (x) => REF_ALPHABET[x % REF_ALPHABET.length]).join('');
    try {
      const r = await pool.query('UPDATE users SET ref_code = $1 WHERE id = $2 AND ref_code IS NULL RETURNING ref_code', [code, user.id]);
      if (r.rows[0]) return r.rows[0].ref_code;
      const again = await pool.query('SELECT ref_code FROM users WHERE id = $1', [user.id]);
      if (again.rows[0] && again.rows[0].ref_code) return again.rows[0].ref_code;
    } catch (e) {
      if (e.code !== '23505') throw e; // такий код уже є: пробуємо інший
    }
  }
  throw new Error('ref_code');
}

app.get('/api/bonus', async (req, res) => {
  try {
    const account = await requireAccount(req, res);
    if (!account) return;
    const u = account.user;
    const [code, bal, tx, friends, last] = await Promise.all([
      ensureRefCode(u),
      bonusBalance(pool, u.id),
      pool.query('SELECT amount, kind, note, created_at FROM bonus_tx WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [u.id]),
      pool.query('SELECT name, referral_state, created_at FROM users WHERE referred_by = $1 ORDER BY id DESC LIMIT 50', [u.id]),
      pool.query(`SELECT MAX(created_at) AS t FROM bonus_tx WHERE user_id = $1 AND amount > 0 AND kind <> 'refund'`, [u.id])
    ]);
    const lastAct = last.rows[0].t;
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      balance: bal,
      rules: { percent: BONUS.percent, maxShare: BONUS.maxShare, referral: BONUS.referral, welcome: BONUS.welcome, expireDays: BONUS.expireDays },
      expiresAt: bal > 0 && lastAct ? new Date(new Date(lastAct).getTime() + BONUS.expireDays * 86400000) : null,
      history: tx.rows.map(txOut),
      refCode: code,
      refLink: `${String(SITE_URL || 'https://level-vr-club.vn.ua').replace(/\/+$/, '')}/?ref=${code}`,
      friends: friends.rows.map((f) => ({ name: firstName(f.name), state: f.referral_state || 'pending', at: f.created_at })),
      referredBy: !!u.referred_by
    });
  } catch (e) {
    console.error('bonus:', e.message);
    res.status(500).json({ success: false, message: 'Помилка сервера.' });
  }
});

// Новий клієнт прийшов за посиланням друга: запамʼятовуємо, хто запросив
app.post('/api/bonus/referral', async (req, res) => {
  try {
    if (!authOrigin(req, res)) return;
    const account = await requireAccount(req, res);
    if (!account) return;
    const u = account.user;
    const code = String((req.body && req.body.code) || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(code)) return res.status(400).json({ success: false, message: 'Некоректний код.' });
    if (u.referred_by) return res.json({ success: true, applied: false, reason: 'already' });

    const inviter = (await pool.query('SELECT * FROM users WHERE ref_code = $1', [code])).rows[0];
    if (!inviter) return res.json({ success: true, applied: false, reason: 'unknown' });
    if (inviter.id === u.id) return res.json({ success: true, applied: false, reason: 'self' });
    const tail = phoneTail(u.phone);
    if (tail && tail === phoneTail(inviter.phone)) return res.json({ success: true, applied: false, reason: 'self' });

    // Лише для нових акаунтів, які ще не бронювали
    const fresh = (Date.now() - new Date(u.created_at).getTime()) < 3 * 86400000;
    const booked = await pool.query('SELECT 1 FROM bookings WHERE user_id = $1 LIMIT 1', [u.id]);
    if (!fresh || booked.rows.length) return res.json({ success: true, applied: false, reason: 'old' });

    const r = await pool.query(
      `UPDATE users SET referred_by = $1, referral_state = 'pending' WHERE id = $2 AND referred_by IS NULL RETURNING id`, [inviter.id, u.id]);
    res.json({ success: true, applied: !!r.rows[0], inviter: firstName(inviter.name), bonus: BONUS.referral });
  } catch (e) {
    console.error('bonus/referral:', e.message);
    res.status(500).json({ success: false, message: 'Помилка сервера.' });
  }
});

// Адмін: клієнт не прийшов — балів за гру не буде, списані бали повертаються
app.post('/api/admin/booking/noshow', async (req, res) => {
  try {
    if (!authOrigin(req, res)) return;
    const account = await requireSiteAdmin(req, res);
    if (!account) return;
    const id = bookingIdFrom(req.body);
    if (!id) return res.status(400).json({ success: false, message: 'Некоректне бронювання.' });
    const r = await pool.query(`UPDATE bookings SET bonus_state = 'noshow' WHERE id = $1 AND bonus_state = 'new' RETURNING *`, [id]);
    const b = r.rows[0];
    if (!b) return res.status(409).json({ success: false, message: 'Бали за цю гру вже нараховані або гру вже позначено.' });
    await refundBookingBonus(b);
    tellGroup(`🚫 #${id} (${b.name}, ${fmtDate(b.booking_date)} ${b.booking_time}) — не прийшов. Позначив ${adminWho(account)}`);
    res.json({ success: true });
  } catch (e) {
    console.error('admin/noshow:', e.message);
    res.status(500).json({ success: false, message: 'Помилка сервера.' });
  }
});

// Адмін: нарахувати або списати бали вручну (подарунок, виправлення)
app.post('/api/admin/bonus/adjust', async (req, res) => {
  try {
    if (!authOrigin(req, res)) return;
    const account = await requireSiteAdmin(req, res);
    if (!account) return;
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const userId = /^\d{1,9}$/.test(String(b.userId)) ? Number(b.userId) : null;
    const amount = Number(b.amount);
    const reason = String(b.reason ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 150);
    if (!userId) return res.status(400).json({ success: false, message: 'Некоректний клієнт.' });
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100000) {
      return res.status(400).json({ success: false, message: 'Вкажіть ціле число балів (наприклад 50 або -50).' });
    }
    if (reason.length < 2) return res.status(400).json({ success: false, message: 'Вкажіть причину.' });

    const db = await pool.connect();
    let balance;
    let user;
    try {
      await db.query('BEGIN');
      user = (await db.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
      if (!user) { await db.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Клієнта не знайдено.' }); }
      const bal = await bonusBalance(db, userId);
      if (bal + amount < 0) {
        await db.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `На рахунку лише ${bal} балів.` });
      }
      await addBonusTx(db, userId, amount, 'admin', null, `${reason} (${adminWho(account)})`);
      await db.query('COMMIT');
      balance = bal + amount;
    } catch (e) {
      try { await db.query('ROLLBACK'); } catch (_) { /* вже відкочено */ }
      throw e;
    } finally {
      db.release();
    }
    if (amount > 0) tellUser(user, `🎁 Вам нараховано ${amount} балів у LEVEL VR CLUB: ${reason}. На рахунку: ${balance}.`);
    res.json({ success: true, balance });
  } catch (e) {
    console.error('admin/bonus:', e.message);
    res.status(500).json({ success: false, message: 'Помилка сервера.' });
  }
});

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