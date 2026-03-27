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

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, '../FrondEnd')));

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

/* ================= BOT ================= */
const bot = new TelegramBot(TOKEN, { polling: true });

/* ================= DB ================= */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  const client = await pool.connect();
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

  if (payload && payload.startsWith('order_')) {
    const id = payload.split('_')[1];
    await pool.query('UPDATE bookings SET client_chat_id=$1 WHERE id=$2', [chatId, id]);
    bot.sendMessage(chatId, `✅ Ви підключені до замовлення #${id}`);
  } else if (!isAdmin(chatId)) {
    bot.sendMessage(chatId, "🎮 Вітаємо у LEVEL VR CLUB!");
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
  const res = await pool.query('SELECT * FROM bookings WHERE booking_date=$1', [today]);

  if (!res.rows.length) return bot.sendMessage(msg.chat.id, 'Немає замовлень');

  let text = '📅 СЬОГОДНІ:\n\n';
  res.rows.forEach(b => text += `${b.booking_time} - ${b.name}\n`);
  bot.sendMessage(msg.chat.id, text);
});

/* ================= BOOK ================= */
app.post('/api/book', async (req, res) => {
  try {
    const { cart, totalPrice, date, time, name, phone, comment } = req.body;

    const result = await pool.query(
      `INSERT INTO bookings (name, phone, booking_date, booking_time, total_price, cart_details, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [name, phone, date, time, totalPrice, JSON.stringify(cart), comment]
    );

    const id = result.rows[0].id;

    await bot.sendMessage(
      ADMIN_CHAT_ID,
      `🔥 <b>Замовлення #${id}</b>\n👤 ${name}\n📞 ${phone}\n📅 ${date} ${time}`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Підтвердити', callback_data: `confirm_${id}` },
              { text: '❌ Скасувати', callback_data: `cancel_${id}` }
            ]
          ]
        }
      }
    );

    res.json({ success: true, orderId: id });
  } catch {
    res.status(500).json({ success: false });
  }
});

/* ================= CANCEL FLOW ================= */
const cancelReasons = {};

/* ================= CALLBACK ================= */
bot.on('callback_query', async (q) => {
  const action = q.data;
  const id = action.split('_')[1];
  const adminId = q.message.chat.id;

  if (!isAdmin(adminId)) return;

  if (action.startsWith('confirm_')) {
    const res = await pool.query('SELECT client_chat_id FROM bookings WHERE id=$1', [id]);

    if (res.rows[0]?.client_chat_id) {
      bot.sendMessage(res.rows[0].client_chat_id, `✅ Бронювання #${id} підтверджено`);
    }

    bot.editMessageText(q.message.text + `\n\n✅ ПІДТВЕРДЖЕНО`, {
      chat_id: adminId,
      message_id: q.message.message_id,
      parse_mode: 'HTML'
    });
  }

  if (action.startsWith('cancel_')) {
    cancelReasons[adminId] = id;
    bot.sendMessage(adminId, `✏️ Напишіть причину для #${id}`);
  }

  bot.answerCallbackQuery(q.id);
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

/* ================= REMINDER ================= */
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();

  const res = await pool.query('SELECT * FROM bookings');

  res.rows.forEach(b => {
    const [h, m] = b.booking_time.split(':');
    const time = h * 60 + Number(m);

    if (time - current === 60 && b.client_chat_id) {
      bot.sendMessage(b.client_chat_id, '🔔 Через годину гра!');
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