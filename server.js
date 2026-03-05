require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
  if (err) return console.error('❌ Помилка підключення до БД:', err.message);
  console.log('✅ Успішно підключено до PostgreSQL');
  
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100),
      phone VARCHAR(50),
      booking_date VARCHAR(20),
      booking_time VARCHAR(20),
      total_price NUMERIC,
      cart_details JSONB,
      comment TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  client.query(createTableQuery, (err, res) => {
    if (!err) {
      // Додаємо колонку для клієнтського Telegram, якщо її немає
      client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_chat_id VARCHAR(50);', (err2) => {
        release();
        console.log('✅ Таблиця "bookings" готова до роботи з клієнтами');
      });
    } else {
      release();
    }
  });
});

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'FrondEnd')));

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.TELEGRAM_CHAT_ID;
const bot = new TelegramBot(token, { polling: true });
console.log('🤖 Telegram-бот запущений');

// ===== ОБРОБКА ПЕРЕХОДУ КЛІЄНТА В БОТА =====
bot.onText(/\/start(?: (.*))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const payload = match[1]; // Отримуємо частину після /start (наприклад, order_15)

  if (payload && payload.startsWith('order_')) {
    const orderId = payload.split('_')[1];
    try {
      // Зберігаємо chat_id клієнта в базу
      await pool.query('UPDATE bookings SET client_chat_id = $1 WHERE id = $2', [chatId, orderId]);
      bot.sendMessage(chatId, `🎉 Вітаємо! Ваша заявка #${orderId} прийнята в обробку.\n\nОчікуйте на повідомлення про підтвердження бронювання від нашого адміністратора!`);
    } catch (err) {
      console.error(err);
    }
  } else if (chatId.toString() !== adminChatId) {
    bot.sendMessage(chatId, "🎮 Вітаємо у боті LEVEL VR CLUB!");
  }
});

// ===== КОМАНДИ АДМІНІСТРАТОРА =====
bot.onText(/\/clear/, async (msg) => {
  if (msg.chat.id.toString() !== adminChatId) return;
  try {
    await pool.query('TRUNCATE TABLE bookings RESTART IDENTITY');
    bot.sendMessage(adminChatId, '🧹 <b>Базу повністю очищено!</b>', { parse_mode: 'HTML' });
  } catch (err) {}
});

bot.onText(/\/today/, async (msg) => {
  if (msg.chat.id.toString() !== adminChatId) return;
  const today = new Date().toISOString().split('T')[0];
  try {
    const res = await pool.query('SELECT * FROM bookings WHERE booking_date = $1 ORDER BY booking_time', [today]);
    if (res.rows.length === 0) return bot.sendMessage(adminChatId, 'На сьогодні немає замовлень.');
    let text = `📅 <b>ЗАМОВЛЕННЯ НА СЬОГОДНІ:</b>\n\n`;
    res.rows.forEach(b => text += `⏰ <b>${b.booking_time}</b> | ${b.name} (${b.phone})\n`);
    bot.sendMessage(adminChatId, text, { parse_mode: 'HTML' });
  } catch (err) {}
});

// ===== КНОПКИ ПІДТВЕРДИТИ / СКАСУВАТИ =====
bot.on('callback_query', async (query) => {
  const action = query.data; 
  const msg = query.message;
  const bookingId = action.split('_')[1];

  try {
    if (action.startsWith('confirm_')) {
      // 1. Отримуємо chat_id клієнта з бази
      const res = await pool.query('SELECT client_chat_id FROM bookings WHERE id = $1', [bookingId]);
      const clientChatId = res.rows[0]?.client_chat_id;

      // 2. Якщо клієнт перейшов у бота, надсилаємо йому квиток!
      let clientNotified = "❌ НЕ НАДІСЛАНО (клієнт не перейшов у бота)";
      if (clientChatId) {
         await bot.sendMessage(clientChatId, `✅ <b>БРОНЮВАННЯ ПІДТВЕРДЖЕНО!</b>\n\nВаша заявка #${bookingId} успішно схвалена. Чекаємо на вас у LEVEL VR CLUB! 🎮`, { parse_mode: 'HTML' });
         clientNotified = "✅ НАДІСЛАНО КЛІЄНТУ";
      }

      // 3. Оновлюємо повідомлення для адміна
      const newText = msg.text + `\n\n✅ <b>СТАТУС: ПІДТВЕРДЖЕНО</b>\nСповіщення: ${clientNotified}`;
      await bot.editMessageText(newText, { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'HTML' });
    } 
    else if (action.startsWith('cancel_')) {
      // Видаляємо бронь
      await pool.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
      const newText = msg.text + `\n\n❌ <b>СТАТУС: СКАСОВАНО ТА ВИДАЛЕНО</b>`;
      await bot.editMessageText(newText, { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'HTML' });
    }
    bot.answerCallbackQuery(query.id);
  } catch (err) {
    bot.answerCallbackQuery(query.id, { text: 'Помилка' });
  }
});

// ===== API БРОНЮВАННЯ =====
app.post('/api/book', async (req, res) => {
  try {
    const { cart, totalPrice, date, time, name, phone, comment } = req.body;
    if (!cart || cart.length === 0) return res.status(400).json({ success: false, message: 'Кошик порожній' });

    const [hour] = time.split(':').map(Number);
    if (hour < 10 || hour >= 22) return res.status(400).json({ success: false, message: 'Працюємо з 10:00 до 22:00.' });

    const today = new Date().toISOString().split('T')[0];
    try { await pool.query('DELETE FROM bookings WHERE booking_date < $1', [today]); } catch (e) {}

    const INVENTORY = { "PS 5 Pro": 3, "Oculus": 2, "PS VR 2": 1, "VIP": 1 };
    const timeToMins = (t) => t.split(':').map(Number).reduce((h, m) => h * 60 + m);
    const newStart = timeToMins(time);

    const dbRes = await pool.query('SELECT booking_time, cart_details FROM bookings WHERE booking_date = $1', [date]);
    const existingBookings = dbRes.rows;
    const currentCartCounts = {};

    for (const newItem of cart) {
      const deviceName = newItem.device;
      const newEnd = newStart + (newItem.duration * 60); 
      let alreadyBookedCount = currentCartCounts[deviceName] || 0;

      for (const booking of existingBookings) {
        const existStart = timeToMins(booking.booking_time);
        const existCart = typeof booking.cart_details === 'string' ? JSON.parse(booking.cart_details) : booking.cart_details;
        for (const existItem of existCart) {
          if (existItem.device === deviceName) {
            const existEnd = existStart + (existItem.duration * 60);
            if (newStart < existEnd && newEnd > existStart) alreadyBookedCount += 1; 
          }
        }
      }
      const maxAllowed = INVENTORY[deviceName] || 1;
      if (alreadyBookedCount >= maxAllowed) {
        return res.status(400).json({ success: false, message: `На цей час "${deviceName}" вже зайнято.` });
      }
      currentCartCounts[deviceName] = (currentCartCounts[deviceName] || 0) + 1;
    }

    const insertQuery = `INSERT INTO bookings (name, phone, booking_date, booking_time, total_price, cart_details, comment) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id;`;
    const values = [name, phone, date, time, totalPrice, JSON.stringify(cart), comment];
    const dbResult = await pool.query(insertQuery, values);
    const newId = dbResult.rows[0].id;

    let tgMsg = `<b>👾 НОВЕ ЗАМОВЛЕННЯ #${newId}!</b>\n\n👤 <b>Ім'я:</b> ${name}\n📞 <b>Телефон:</b> ${phone}\n📅 <b>Дата:</b> ${date}\n⏰ <b>Час:</b> ${time}\n\n🛒 <b>ЗАМОВЛЕННЯ:</b>\n`;
    cart.forEach((item, idx) => { tgMsg += `${idx + 1}. ${item.device} (${item.duration} год + 5 хв 🎁) - ${item.price} грн\n`; });
    tgMsg += `\n💰 <b>ЗАГАЛОМ: ${totalPrice} грн</b>`;
    if (comment && comment !== "Немає") tgMsg += `\n\n💬 <b>Коментар:</b> ${comment}`;

    await bot.sendMessage(adminChatId, tgMsg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Підтвердити', callback_data: `confirm_${newId}` }, { text: '❌ Скасувати', callback_data: `cancel_${newId}` }]
        ]
      }
    });

    // ВАЖЛИВО: Віддаємо newId на фронтенд, щоб зробити посилання!
    res.json({ success: true, message: `Успішно!`, orderId: newId });

  } catch (err) {
    res.status(500).json({ success: false, message: 'Помилка сервера' });
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Сервер на порту ${PORT}`));