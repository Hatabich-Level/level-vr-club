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

  // Секретний токен для привʼязки клієнта до замовлення через Telegram-бота
  await client.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS claim_token TEXT`);

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

  const comment = clean(b.comment, 500) || 'Немає';
  return { data: { name, phone, digits, date, time, cart, total, comment } };
}

const PHONE_TAIL_SQL = "RIGHT(regexp_replace(phone, '\\D', '', 'g'), 9)";

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

    // 5. Зберігаємо. client_chat_id з запиту НЕ приймаємо: його ставить лише бот за секретним посиланням
    const claimToken = crypto.randomBytes(8).toString('hex');
    const dbRes = await pool.query(
      `INSERT INTO bookings (name, phone, booking_date, booking_time, total_price, cart_details, comment, claim_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [name, phone, date, time, total, JSON.stringify(cart), comment, claimToken]
    );
    const newId = dbRes.rows[0].id;
    acceptedAt.push(Date.now());

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

    res.json({ success: true, orderId: newId, claimToken });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: `Помилка сервера. Спробуйте пізніше. ${CALL_US}` });
  }
});

/* ================= CANCEL FLOW ================= */
const cancelReasons = {};

/* ================= CALLBACK ================= */
bot.on('callback_query', async (query) => {
  const action = query.data; // ВАЖЛИВО: Оголошуємо action!
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const orderId = action.split('_')[1];

  try {
    if (action.startsWith('confirm_')) {
      const res = await pool.query('SELECT client_chat_id, booking_time FROM bookings WHERE id = $1', [orderId]);
      
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
async function applyMove(adminChatId, id, input, source) {
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