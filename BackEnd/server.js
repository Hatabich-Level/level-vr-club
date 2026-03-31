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

    // Форматуємо кошик для повідомлення (підлаштуйте ключі item.title/item.price під ваш фронтенд, якщо вони інші)
    let cartText = '';
    if (cart && cart.length > 0) {
      cart.forEach((item, index) => {
        cartText += `${index + 1}. ${item.title || item.name} - ${item.price} грн\n`;
      });
    } else {
      cartText = 'Порожньо';
    }

    const result = await pool.query(
      `INSERT INTO bookings (name, phone, booking_date, booking_time, total_price, cart_details, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [name, phone, date, time, totalPrice, JSON.stringify(cart), comment]
    );

    const id = result.rows[0].id;

    // Створюємо текст за вашим шаблоном
    const messageText = `👾 НОВЕ ЗАМОВЛЕННЯ #${id}!\n\n` +
      `👤 Ім'я: ${name}\n` +
      `📞 Телефон: ${phone}\n` +
      `📅 Дата: ${date}\n` +
      `⏰ Час: ${time}\n\n` +
      `🛒 ЗАМОВЛЕННЯ:\n${cartText}\n` +
      `💰 ЗАГАЛОМ: ${totalPrice} грн\n\n` +
      `⏳ СТАТУС: ОЧІКУЄ ПІДТВЕРДЖЕННЯ`;

    await bot.sendMessage(
      ADMIN_CHAT_ID,
      messageText,
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
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false });
  }
});

/* ================= CANCEL FLOW ================= */
const cancelReasons = {};

/* ================= CALLBACK ================= */
if (action.startsWith('confirm_')) {
    const res = await pool.query('SELECT client_chat_id FROM bookings WHERE id=$1', [id]);

    let notifyStatus = '❌ НЕ ПІДКЛЮЧЕНО (Бот не зміг написати)';
    if (res.rows[0]?.client_chat_id) {
      bot.sendMessage(res.rows[0].client_chat_id, `✅ Бронювання #${id} підтверджено на ${res.rows[0].booking_time || 'ваш час'}`);
      notifyStatus = '✅ НАДІСЛАНО КЛІЄНТУ';
    }

    // Замінюємо старий статус на новий у тексті повідомлення
    const newText = q.message.text.replace(
      '⏳ СТАТУС: ОЧІКУЄ ПІДТВЕРДЖЕННЯ', 
      `✅ СТАТУС: ПІДТВЕРДЖЕНО\nСповіщення: ${notifyStatus}`
    );

    bot.editMessageText(newText, {
      chat_id: adminId,
      message_id: q.message.message_id,
      parse_mode: 'HTML' // Кнопки зникають автоматично, оскільки ми не передаємо reply_markup
    });
  } else if (action.startsWith('cancel_')) {
    cancelReasons[adminId] = id;
    bot.sendMessage(adminId, `❌ Введіть причину скасування замовлення #${id}`);
  }


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

// Обробка повідомлення з новою грою
bot.on('message', async (msg) => {
  if (!isAdmin(msg.chat.id) || !msg.text) return;

  if (msg.text.startsWith('+гра |')) {
    const parts = msg.text.split('|').map(p => p.trim());
    
    if (parts.length === 5) {
      const [_, platform, title, description, imageUrl] = parts;
      
      try {
        await pool.query(
          'INSERT INTO games (title, platform, description, image_url) VALUES ($1, $2, $3, $4)', 
          [title, platform, description, imageUrl]
        );
        bot.sendMessage(msg.chat.id, `✅ Гру <b>${title}</b> (${platform}) успішно додано до бази!`, { parse_mode: 'HTML' });
      } catch (err) {
        bot.sendMessage(msg.chat.id, `❌ Помилка БД: ${err.message}`);
      }
    } else {
      bot.sendMessage(msg.chat.id, '❌ Помилка формату. Перевірте, чи всі 4 параметри вказані через `|`');
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