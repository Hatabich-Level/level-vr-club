require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ===== Middleware =====
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'FrondEnd')));

// ===== Telegram повідомлення =====
async function sendTelegram(message) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return console.error("❌ Telegram credentials missing");

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body = {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML'
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      console.error('❌ Telegram send error:', await response.text());
    } else {
      console.log('✅ Telegram message sent');
    }
  } catch (err) {
    console.error('❌ Telegram error:', err);
  }
}

// ===== WebSocket (адмін-панель) =====
io.on('connection', socket => {
  console.log('📡 Admin connected');
  socket.on('disconnect', () => console.log('🔌 Admin disconnected'));
});

// ===== API бронювання =====
app.post('/api/book', async (req, res) => {
  try {
    const { cart, totalPrice, date, time, name, phone, comment } = req.body;

    if (!cart || !Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ success: false, message: 'Порожній кошик' });
    }
    if (!date || !time) {
      return res.status(400).json({ success: false, message: 'Оберіть дату та час' });
    }

    // Формування тексту для Telegram
    const tgMsg = `
📢 <b>Нове бронювання у Level VR Club</b>

👤 Ім'я: <b>${name || 'не вказано'}</b>
📞 Телефон: ${phone || '—'}
📅 Дата: ${date}
🕒 Час: ${time}
💰 Сума: <b>${totalPrice} грн</b>

🎮 <b>Обрано:</b>
${cart.map((c, i) => `${i + 1}) ${c.device} — ${c.duration} год, ${c.persons} ос. — ${c.price} грн`).join('\n')}

💬 Коментар: ${comment || '—'}

🕓 Створено: ${new Date().toLocaleString('uk-UA')}
`.trim();

    // Відправка у Telegram
    await sendTelegram(tgMsg);

    // Шлемо також у адмін-панель через Socket.io
    io.emit('newBooking', { cart, totalPrice, date, time, name, phone, comment });

    return res.json({ success: true, message: 'Бронювання надіслано ✅' });
  } catch (err) {
    console.error('❌ Помилка бронювання:', err);
    return res.status(500).json({ success: false, message: 'Помилка сервера' });
  }
});

// ===== Запуск сервера =====
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});