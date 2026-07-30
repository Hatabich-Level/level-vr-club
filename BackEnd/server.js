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


/* ================= HELPERS ================= */
async function gameExistsByTitle(title) {
  if (!title) return false;
  const result = await pool.query(
    'SELECT id FROM games WHERE LOWER(title) = LOWER($1) LIMIT 1',
    [title.trim()]
  );
  return result.rows.length > 0;
}

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
    const { cart = [], totalPrice, date, time, name, phone, comment, clientChatId } = req.body;

    const dbRes = await pool.query(
      `INSERT INTO bookings (name, phone, booking_date, booking_time, total_price, cart_details, comment, client_chat_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [name, phone, date, time, totalPrice, JSON.stringify(cart), comment, clientChatId]
    );
    const newId = dbRes.rows[0].id;

    let tgMsg = `<b>👾 НОВЕ ЗАМОВЛЕННЯ #${newId}!</b>\n\n`;
    tgMsg += `👤 <b>Ім'я:</b> ${name}\n`;
    tgMsg += `📞 <b>Телефон:</b> <code>${phone}</code>\n`;
    tgMsg += `📅 <b>Дата:</b> ${date}\n`;
    tgMsg += `⏰ <b>Час:</b> ${time}\n\n`;
    tgMsg += `🛒 <b>ЗАМОВЛЕННЯ:</b>\n`;

    // Перевіряємо різні назви полів (device або name)
    cart.forEach((item, idx) => {
      const title = item.device || item.name || item.title || "Послуга";
      const dur = item.duration || "?";
      tgMsg += `${idx + 1}. ${title} (${dur} год + 5 хв 🎁) — ${item.price} грн\n`;
    });

    tgMsg += `\n💰 <b>ЗАГАЛОМ: ${totalPrice} грн</b>`;
    if (comment && comment !== "Немає") tgMsg += `\n\n💬 <b>Коментар:</b> <i>${comment}</i>`;
    tgMsg += `\n\n⏳ <b>СТАТУС: ОЧІКУЄ ПІДТВЕРДЖЕННЯ</b>`;

    await bot.sendMessage(ADMIN_CHAT_ID, tgMsg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Підтвердити', callback_data: `confirm_${newId}` },
            { text: '❌ Скасувати', callback_data: `cancel_${newId}` }
          ]
        ]
      }
    });

    res.json({ success: true, orderId: newId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

/* ================= CANCEL FLOW ================= */
const cancelReasons = {};

/* ================= ОЧІКУВАННЯ ПІДТВЕРДЖЕННЯ ГРИ (Telegram) ================= */
const pendingGameAdds = {};

function escapeIgdbQuery(str) {
  return String(str).replace(/"/g, '\\"');
}

// Оцінюємо наскільки назва гри з IGDB відповідає введеному запиту.
// Менше значення = кращий збіг.
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

/* ================= CALLBACK ================= */
bot.on('callback_query', async (query) => {
  const action = query.data; // ВАЖЛИВО: Оголошуємо action!
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    if (action === 'gameadd_yes') {
      const pending = pendingGameAdds[chatId];
      if (!pending) {
        await bot.answerCallbackQuery(query.id, { text: 'Немає активної гри для додавання' });
        return;
      }

      const alreadyExists = await gameExistsByTitle(pending.title);
      if (alreadyExists) {
        await bot.editMessageCaption(`⚠️ Гра "${pending.title}" вже є в каталозі. Пропущено.`, {
          chat_id: chatId, message_id: messageId
        });
      } else {
        await pool.query(
          'INSERT INTO games (title, platform, description, image_url) VALUES ($1, $2, $3, $4)',
          [pending.title, pending.platform, pending.description, pending.image_url]
        );
        await bot.editMessageCaption(`✅ Гру "${pending.title}" додано на сайт!`, {
          chat_id: chatId, message_id: messageId
        });
      }
      delete pendingGameAdds[chatId];
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (action === 'gameadd_no') {
      delete pendingGameAdds[chatId];
      await bot.editMessageCaption('❌ Додавання гри скасовано. Спробуйте ввести точнішу назву.', {
        chat_id: chatId, message_id: messageId
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const orderId = action.split('_')[1];

    if (action.startsWith('confirm_')) {
      const res = await pool.query('SELECT client_chat_id, booking_time FROM bookings WHERE id = $1', [orderId]);
      
      if (res.rows[0]?.client_chat_id) {
        await bot.sendMessage(res.rows[0].client_chat_id, `✅ Замовлення #${orderId} підтверджено на ${res.rows[0].booking_time}!`);
      }

      const updatedText = query.message.text.replace('⏳ СТАТУС: ОЧІКУЄ ПІДТВЕРДЖЕННЯ', '✅ СТАТУС: ПІДТВЕРДЖЕНО');
      await bot.editMessageText(updatedText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML'
      });
    } 
    else if (action.startsWith('cancel_')) {
      cancelReasons[chatId] = orderId;
      bot.sendMessage(chatId, `❌ Введіть причину скасування для #${orderId}:`);
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
                data: `search "${escapeIgdbQuery(gameName)}"; fields name, summary, platforms.name, cover.url; limit 10;`
            });

            if (response.data.length === 0) {
                return bot.sendMessage(chatId, "❌ Гру не знайдено. Спробуйте точнішу назву англійською.");
            }

            // Сортуємо результати за релевантністю до введеної назви,
            // щоб не брати випадковий перший варіант з IGDB (звідси й був баг з чужими іграми)
            const sorted = sortGamesByRelevance(response.data, gameName, 'name');
            const game = sorted[0];

            // ЗАХИСТ ВІД ДУБЛІКАТІВ
            const alreadyExists = await gameExistsByTitle(game.name);
            if (alreadyExists) {
                return bot.sendMessage(chatId, `⚠️ Гра <b>${game.name}</b> вже є в каталозі. Пропущено, щоб не дублювати.`, { parse_mode: 'HTML' });
            }

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

            // Зберігаємо гру як "очікує підтвердження" — НЕ вставляємо в базу одразу
            pendingGameAdds[chatId] = {
                title: game.name,
                platform: mainPlatform,
                description: description.substring(0, 500) + '...',
                image_url: imageUrl
            };

            bot.sendPhoto(chatId, imageUrl, {
                caption: `❓ <b>Це та гра?</b>\n\n🎮 <b>Назва:</b> ${game.name}\n🕹 <b>Платформи:</b> ${platforms}\n\n<i>Перевірте назву — якщо це не та гра, натисніть "Ні" і спробуйте ввести точнішу назву (бажано англійською).</i>`,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Так, додати', callback_data: 'gameadd_yes' },
                            { text: '❌ Ні, скасувати', callback_data: 'gameadd_no' }
                        ]
                    ]
                }
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

/* ================= ДОДАВАННЯ ІГОР ЧЕРЕЗ САЙТ (без Telegram) ================= */
const SITE_ADMIN_KEY = process.env.SITE_ADMIN_KEY;

function checkSiteKey(req, res) {
  if (!SITE_ADMIN_KEY || req.body.key !== SITE_ADMIN_KEY) {
    res.status(403).json({ error: 'Невірний ключ доступу' });
    return false;
  }
  return true;
}

// Пошук ігор у IGDB прямо з сайту (повертає кілька варіантів на вибір)
app.post('/api/games/search-site', async (req, res) => {
  if (!checkSiteKey(req, res)) return;

  const query = (req.body.query || '').trim();
  if (!query) {
    return res.status(400).json({ error: 'Введіть назву гри' });
  }

  try {
    const token = await getIgdbToken();
    if (!token) return res.status(500).json({ error: 'Помилка авторизації IGDB' });

    const response = await axios({
      url: 'https://api.igdb.com/v4/games',
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Client-ID': TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`
      },
      data: `search "${escapeIgdbQuery(query)}"; fields name, summary, platforms.name, cover.url; limit 8;`
    });

    const sortedData = sortGamesByRelevance(response.data, query, 'name');

    const results = await Promise.all(sortedData.map(async (game) => {
      let imageUrl = "https://via.placeholder.com/500x700?text=No+Image";
      if (game.cover && game.cover.url) {
        imageUrl = 'https:' + game.cover.url.replace('t_thumb', 't_1080p');
      }

      const platformsList = game.platforms ? game.platforms.map(p => p.name).join(', ') : 'Невідомо';
      let mainPlatform = 'Console';
      if (platformsList.includes('PlayStation 5')) mainPlatform = 'PS5';
      else if (platformsList.includes('PlayStation 4')) mainPlatform = 'PS4';
      else if (platformsList.includes('PC')) mainPlatform = 'PC';
      else if (platformsList.includes('VR')) mainPlatform = 'VR';

      const description = (game.summary || 'Опис відсутній.').substring(0, 500);
      const alreadyExists = await gameExistsByTitle(game.name);

      return {
        title: game.name,
        platform: mainPlatform,
        platformsFull: platformsList,
        description,
        image_url: imageUrl,
        exists: alreadyExists
      };
    }));

    res.json(results);
  } catch (err) {
    console.error('Помилка пошуку IGDB (сайт):', err.response ? err.response.data : err.message);
    if (err.response && err.response.status === 401) igdbAccessToken = null;
    res.status(500).json({ error: 'Помилка пошуку гри' });
  }
});

// Додавання обраної гри з сайту (з повторною перевіркою дублікатів)
app.post('/api/games/add-site', async (req, res) => {
  if (!checkSiteKey(req, res)) return;

  const game = req.body.game;
  if (!game || !game.title) {
    return res.status(400).json({ error: 'Немає даних гри' });
  }

  try {
    const alreadyExists = await gameExistsByTitle(game.title);
    if (alreadyExists) {
      return res.status(409).json({ error: 'Ця гра вже є в каталозі' });
    }

    const result = await pool.query(
      'INSERT INTO games (title, platform, description, image_url) VALUES ($1, $2, $3, $4) RETURNING *',
      [game.title, game.platform || 'Console', game.description || '', game.image_url || '']
    );

    if (ADMIN_CHAT_ID) {
      bot.sendMessage(ADMIN_CHAT_ID, `🎮 Гру "${game.title}" додано через сайт (без Telegram).`);
    }

    res.json({ success: true, game: result.rows[0] });
  } catch (err) {
    console.error('Помилка додавання гри (сайт):', err.message);
    res.status(500).json({ error: 'Помилка додавання гри' });
  }
});

// Видалення гри з каталогу через сайт
app.post('/api/games/delete-site', async (req, res) => {
  if (!checkSiteKey(req, res)) return;

  const id = req.body.id;
  if (!id) {
    return res.status(400).json({ error: 'Немає id гри' });
  }

  try {
    const result = await pool.query('DELETE FROM games WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Гру не знайдено' });
    }

    if (ADMIN_CHAT_ID) {
      bot.sendMessage(ADMIN_CHAT_ID, `🗑 Гру "${result.rows[0].title}" видалено через сайт.`);
    }

    res.json({ success: true, game: result.rows[0] });
  } catch (err) {
    console.error('Помилка видалення гри (сайт):', err.message);
    res.status(500).json({ error: 'Помилка видалення гри' });
  }
});