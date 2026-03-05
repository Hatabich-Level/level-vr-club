require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api'); // Підключаємо бота

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ===== 1. Налаштування підключення до PostgreSQL =====
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
    release();
    if (err) console.error('❌ Помилка створення таблиці:', err.stack);
    else console.log('✅ Таблиця "bookings" готова');
  });
});

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'FrondEnd')));

// ===== 2. ІНІЦІАЛІЗАЦІЯ ТЕЛЕГРАМ БОТА =====
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.TELEGRAM_CHAT_ID;
// Вмикаємо режим polling (бот постійно слухає нові повідомлення)
const bot = new TelegramBot(token, { polling: true });
console.log('🤖 Telegram-бот запущений і готовий до роботи');

// ===== 3. КОМАНДИ БОТА В ТЕЛЕГРАМІ =====

// Команда /clear - Очистити всю базу (тільки для тебе)
bot.onText(/\/clear/, async (msg) => {
  if (msg.chat.id.toString() !== adminChatId) return; // Захист від чужих
  try {
    await pool.query('TRUNCATE TABLE bookings RESTART IDENTITY');
    bot.sendMessage(adminChatId, '🧹 <b>Базу даних повністю очищено!</b> Усі замовлення видалені.', { parse_mode: 'HTML' });
  } catch (err) {
    bot.sendMessage(adminChatId, '❌ Помилка очищення бази.');
  }
});

// Команда /today - Показати замовлення на сьогодні
bot.onText(/\/today/, async (msg) => {
  if (msg.chat.id.toString() !== adminChatId) return;
  const today = new Date().toISOString().split('T')[0];
  try {
    const res = await pool.query('SELECT * FROM bookings WHERE booking_date = $1 ORDER BY booking_time', [today]);
    if (res.rows.length === 0) {
      return bot.sendMessage(adminChatId, '🤷‍♂️ На сьогодні поки немає замовлень.');
    }
    let text = `📅 <b>ЗАМОВЛЕННЯ НА СЬОГОДНІ (${today}):</b>\n\n`;
    res.rows.forEach(b => {
      text += `⏰ <b>${b.booking_time}</b> | ${b.name} (${b.phone})\n`;
    });
    bot.sendMessage(adminChatId, text, { parse_mode: 'HTML' });
  } catch (err) {
    bot.sendMessage(adminChatId, '❌ Помилка отримання даних.');
  }
});

// Обробка натискань на кнопки (Підтвердити / Скасувати)
bot.on('callback_query', async (query) => {
  const action = query.data; // Те, що зашито в кнопку (напр. confirm_15)
  const msg = query.message;
  const bookingId = action.split('_')[1];

  try {
    if (action.startsWith('confirm_')) {
      // Редагуємо повідомлення, прибираємо кнопки і додаємо статус
      const newText = msg.text + `\n\n✅ <b>СТАТУС: ПІДТВЕРДЖЕНО АДМІНІСТРАТОРОМ</b>`;
      await bot.editMessageText(newText, {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        parse_mode: 'HTML'
      });
    } 
    else if (action.startsWith('cancel_')) {
      // Видаляємо бронь з бази даних!
      await pool.query('DELETE FROM bookings WHERE id = $1', [bookingId]);
      
      const newText = msg.text + `\n\n❌ <b>СТАТУС: СКАСОВАНО ТА ВИДАЛЕНО З БАЗИ</b>`;
      await bot.editMessageText(newText, {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        parse_mode: 'HTML'
      });
    }
    // Відправляємо Telegram сигнал, що ми обробили клік (щоб годинник на кнопці не крутився)
    bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error(err);
    bot.answerCallbackQuery(query.id, { text: '❌ Відбулася помилка' });
  }
});


// ===== 4. API Бронювання (з сайту) =====
app.post('/api/book', async (req, res) => {
  try {
    const { cart, totalPrice, date, time, name, phone, comment } = req.body;

    if (!cart || cart.length === 0) return res.status(400).json({ success: false, message: 'Кошик порожній' });

    // Перевірка робочих годин
    const [hour, minute] = time.split(':').map(Number);
    if (hour < 10 || hour >= 22) {
      return res.status(400).json({ success: false, message: 'Ми працюємо з 10:00 до 22:00.' });
    }

    // Авто-очистка вчорашніх (не чіпаємо, хай працює)
    const today = new Date().toISOString().split('T')[0];
    try {
      await pool.query('DELETE FROM bookings WHERE booking_date < $1', [today]);
    } catch (e) {}

    const INVENTORY = { "PS 5 Pro": 3, "Oculus": 2, "PS VR 2": 1, "VIP": 1 };
    const timeToMins = (t) => t.split(':').map(Number).reduce((h, m) => h * 60 + m);
    const newStart = timeToMins(time);

    // Перевірка зайнятості
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
        return res.status(400).json({ 
          success: false, 
          message: `Вибачте, на цей час "${deviceName}" вже заброньовано.` 
        });
      }
      currentCartCounts[deviceName] = (currentCartCounts[deviceName] || 0) + 1;
    }

    // Збереження в базу
    const insertQuery = `INSERT INTO bookings (name, phone, booking_date, booking_time, total_price, cart_details, comment) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id;`;
    const values = [name, phone, date, time, totalPrice, JSON.stringify(cart), comment];
    const dbResult = await pool.query(insertQuery, values);
    const newId = dbResult.rows[0].id;

    // ФОРМУВАННЯ ПОВІДОМЛЕННЯ В TELEGRAM
    let tgMsg = `<b>👾 НОВЕ ЗАМОВЛЕННЯ #${newId}!</b>\n\n`;
    tgMsg += `👤 <b>Ім'я:</b> ${name}\n📞 <b>Телефон:</b> ${phone}\n📅 <b>Дата:</b> ${date}\n⏰ <b>Час:</b> ${time}\n\n🛒 <b>ЗАМОВЛЕННЯ:</b>\n`;
    cart.forEach((item, idx) => {
      tgMsg += `${idx + 1}. ${item.device} (${item.duration} год + 5 хв 🎁, ${item.persons} чол) - ${item.price} грн\n`;
    });
    tgMsg += `\n💰 <b>ЗАГАЛОМ: ${totalPrice} грн</b>`;
    if (comment && comment !== "Немає") tgMsg += `\n\n💬 <b>Коментар:</b> ${comment}`;

    // ВІДПРАВКА З КНОПКАМИ
    await bot.sendMessage(adminChatId, tgMsg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Підтвердити', callback_data: `confirm_${newId}` },
            { text: '❌ Скасувати (Видалити)', callback_data: `cancel_${newId}` }
          ]
        ]
      }
    });

    res.json({ success: true, message: `Бронювання #${newId} успішне!` });

  } catch (err) {
    console.error('❌ Помилка сервера:', err);
    res.status(500).json({ success: false, message: 'Помилка збереження на сервері' });
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Сервер запущено на порту ${PORT}`);
});