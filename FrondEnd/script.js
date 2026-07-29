// =============================================
// 💰 ЄДИНЕ ДЖЕРЕЛО ЦІН — редагуй тільки тут!
// Ці ціни автоматично використовуються на головній
// сторінці (картки тарифів) і в калькуляторі бронювання
// дня народження, щоб не було розсинхрону.
// =============================================
const CLUB_PRICES = {
    ps5: { one: 100, two: 150 }, // PlayStation 5 PRO, грн/год (1 / 2 гравці)
    vip: 200,                    // VIP кімната (PS5 + VR), грн/год за кімнату
    psvr2: 150,                  // PS VR2, грн/год з особи
    oculus: 150,                 // Oculus 2, грн/год з особи
    vr: 150                      // Загальна ціна VR-окулярів з особи (калькулятор ДН)
};

// =============================================
// 🕒 СТАТУС РОБОТИ КЛУБУ (щодня 10:00–22:00, Київський час)
// =============================================
const WORK_HOURS = { openHour: 10, closeHour: 22 }; // без вихідних

function updateWorkStatus() {
    const badge = document.getElementById('workStatusBadge');
    if (!badge) return;

    const textEl = badge.querySelector('.work-status-text');

    // Беремо точний поточний час у Києві незалежно від таймзони відвідувача
    const kyivParts = new Intl.DateTimeFormat('uk-UA', {
        timeZone: 'Europe/Kyiv',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).formatToParts(new Date());

    const hour = parseInt(kyivParts.find(p => p.type === 'hour').value, 10);
    const minute = parseInt(kyivParts.find(p => p.type === 'minute').value, 10);

    const isOpen = hour >= WORK_HOURS.openHour && hour < WORK_HOURS.closeHour;

    badge.classList.toggle('open', isOpen);
    badge.classList.toggle('closed', !isOpen);

    if (isOpen) {
        textEl.textContent = `Працюємо до ${WORK_HOURS.closeHour}:00`;
    } else {
        textEl.textContent = `Зачинено · з ${WORK_HOURS.openHour}:00`;
    }
}

updateWorkStatus();
setInterval(updateWorkStatus, 60 * 1000); // оновлюємо щохвилини

// =============================================
// 🔔 КАСТОМНЕ СПОВІЩЕННЯ (замість браузерного alert)
// =============================================
function showNotification(message, type = 'info') {
    // Видаляємо попереднє сповіщення якщо є
    const existing = document.getElementById('cyber-notification');
    if (existing) existing.remove();

    const icons = {
        info:    '◈',
        success: '✓',
        error:   '✕',
        warning: '⚠',
    };

    const colors = {
        info:    '#00F0FF',
        success: '#00FF99',
        error:   '#FF0055',
        warning: '#FFD700',
    };

    const icon  = icons[type]  || icons.info;
    const color = colors[type] || colors.info;

    const el = document.createElement('div');
    el.id = 'cyber-notification';
    el.innerHTML = `
        <div class="cn-icon" style="color:${color}">${icon}</div>
        <div class="cn-text">${message}</div>
        <div class="cn-close" onclick="this.parentElement.remove()">✕</div>
    `;
    el.style.cssText = `
        position: fixed;
        top: 80px;
        right: 20px;
        z-index: 99999;
        background: #0a0a0a;
        border: 1px solid ${color};
        box-shadow: 0 0 20px ${color}55, 0 4px 30px rgba(0,0,0,0.8);
        padding: 16px 20px;
        max-width: 340px;
        min-width: 260px;
        display: flex;
        align-items: flex-start;
        gap: 12px;
        font-family: 'Noto Sans', sans-serif;
        clip-path: polygon(12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 12px);
        animation: cnSlideIn 0.3s cubic-bezier(0.16,1,0.3,1);
    `;

    // Стилі для внутрішніх елементів
    el.querySelector('.cn-icon').style.cssText = `
        font-size: 22px;
        line-height: 1;
        flex-shrink: 0;
        margin-top: 1px;
        text-shadow: 0 0 10px ${color};
    `;
    el.querySelector('.cn-text').style.cssText = `
        color: #eee;
        font-size: 14px;
        line-height: 1.5;
        flex: 1;
    `;
    el.querySelector('.cn-close').style.cssText = `
        color: #555;
        cursor: pointer;
        font-size: 14px;
        flex-shrink: 0;
        transition: color 0.2s;
        padding: 0 0 0 4px;
        line-height: 1;
    `;
    el.querySelector('.cn-close').onmouseenter = e => e.target.style.color = '#FF0055';
    el.querySelector('.cn-close').onmouseleave = e => e.target.style.color = '#555';

    // Додаємо CSS анімацію якщо ще немає
    if (!document.getElementById('cn-style')) {
        const style = document.createElement('style');
        style.id = 'cn-style';
        style.textContent = `
            @keyframes cnSlideIn {
                from { opacity:0; transform: translateX(40px); }
                to   { opacity:1; transform: translateX(0); }
            }
        `;
        document.head.appendChild(style);
    }

    document.body.appendChild(el);

    // Автозакривання через 4 секунди
    setTimeout(() => {
        if (el.parentElement) {
            el.style.transition = 'opacity 0.4s, transform 0.4s';
            el.style.opacity = '0';
            el.style.transform = 'translateX(40px)';
            setTimeout(() => el.remove(), 400);
        }
    }, 4000);
}

// Кастомний confirm (повертає Promise)
function showConfirm(message) {
    return new Promise(resolve => {
        const existing = document.getElementById('cyber-confirm');
        if (existing) existing.remove();

        const el = document.createElement('div');
        el.id = 'cyber-confirm';
        el.innerHTML = `
            <div class="cc-overlay"></div>
            <div class="cc-box">
                <div class="cc-icon">◈</div>
                <div class="cc-msg">${message}</div>
                <div class="cc-btns">
                    <button class="cc-ok">ОК</button>
                    <button class="cc-cancel">Скасувати</button>
                </div>
            </div>
        `;

        const overlay = el.querySelector('.cc-overlay');
        const box     = el.querySelector('.cc-box');
        const okBtn   = el.querySelector('.cc-ok');
        const cancelBtn = el.querySelector('.cc-cancel');

        overlay.style.cssText = `
            position:fixed; inset:0; background:rgba(0,0,0,0.75);
            backdrop-filter:blur(4px); z-index:99998;
        `;
        box.style.cssText = `
            position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
            z-index:99999; background:#0a0a0a; border:1px solid #00F0FF;
            box-shadow:0 0 30px #00F0FF44; padding:30px 28px;
            max-width:360px; width:90%; text-align:center;
            font-family:'Noto Sans',sans-serif;
            clip-path:polygon(16px 0,100% 0,100% calc(100% - 16px),calc(100% - 16px) 100%,0 100%,0 16px);
            animation:cnSlideIn 0.25s ease;
        `;
        el.querySelector('.cc-icon').style.cssText = `
            color:#00F0FF; font-size:28px; margin-bottom:12px;
            text-shadow:0 0 12px #00F0FF;
        `;
        el.querySelector('.cc-msg').style.cssText = `
            color:#eee; font-size:15px; line-height:1.6; margin-bottom:24px;
        `;
        el.querySelector('.cc-btns').style.cssText = `
            display:flex; gap:12px; justify-content:center;
        `;
        okBtn.style.cssText = `
            flex:1; padding:12px; background:#00F0FF; color:#000;
            border:none; font-weight:900; text-transform:uppercase;
            letter-spacing:1px; cursor:pointer; font-size:14px;
            clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px);
            transition:background 0.2s;
        `;
        cancelBtn.style.cssText = `
            flex:1; padding:12px; background:transparent; color:#888;
            border:1px solid #333; font-weight:700; text-transform:uppercase;
            letter-spacing:1px; cursor:pointer; font-size:14px;
            clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px);
            transition:border-color 0.2s, color 0.2s;
        `;

        okBtn.onmouseenter = () => okBtn.style.background = '#fff';
        okBtn.onmouseleave = () => okBtn.style.background = '#00F0FF';
        cancelBtn.onmouseenter = () => { cancelBtn.style.borderColor='#FF0055'; cancelBtn.style.color='#FF0055'; };
        cancelBtn.onmouseleave = () => { cancelBtn.style.borderColor='#333'; cancelBtn.style.color='#888'; };

        okBtn.onclick     = () => { el.remove(); resolve(true);  };
        cancelBtn.onclick = () => { el.remove(); resolve(false); };
        overlay.onclick   = () => { el.remove(); resolve(false); };

        document.body.appendChild(el);
    });
}

let cart = [];
let totalPrice = 0;
let isSubmitting = false;

// === Скролл та Меню ===
document.addEventListener("DOMContentLoaded", () => {
  const menuToggle = document.querySelector(".menu-toggle");
  const menu = document.querySelector(".menu");

  if (menuToggle && menu) {
    menuToggle.addEventListener("click", () => {
      menu.classList.toggle("active");
      menuToggle.classList.toggle("active");
      // Блокуємо скрол сторінки коли меню відкрите
      document.body.style.overflow = menu.classList.contains("active") ? "hidden" : "";
    });

    menu.querySelectorAll("a").forEach(link => {
      link.addEventListener("click", () => {
        menu.classList.remove("active");
        menuToggle.classList.remove("active");
        document.body.style.overflow = "";
      });
    });

    document.addEventListener("click", (e) => {
      if (!menu.contains(e.target) && !menuToggle.contains(e.target)) {
        menu.classList.remove("active");
        menuToggle.classList.remove("active");
      }
    });
  }
});

// === Відкрити/Закрити бічну панель кошика ===
function toggleCart() {
    const sidebar = document.getElementById('cart-sidebar');
    const overlay = document.getElementById('cart-overlay');
    
    if(sidebar && overlay) {
        sidebar.classList.toggle('open');
        overlay.classList.toggle('open');
        if (sidebar.classList.contains('open')) {
            renderCart();
        }
    }
}

const emptyCartMessages = [
  "Якось тут порожньо...",
  "Сюди б додати щось...",
  "Все ще нічого...",
  "Забагато вільного простору...",
  "Ні на що не натякаю, але..."
];

function getRandomEmptyMessage() {
    const i = Math.floor(Math.random() * emptyCartMessages.length);
    return emptyCartMessages[i];
}

// === Оновлення відображення кошика ===
// Чи є в кошику товар, повʼязаний з VR (потребує підтвердження віку)
function cartHasVr() {
    const vrKeywords = ["VR", "VIP", "Oculus"];
    return cart.some(item =>
        vrKeywords.some(keyword => item.device.toLowerCase().includes(keyword.toLowerCase()))
    );
}

// Показує/ховає блок підтвердження віку (10+) залежно від вмісту кошика
function updateAgeConfirmVisibility() {
    const block = document.getElementById("age-confirm-block");
    if (!block) return;

    if (cartHasVr()) {
        block.classList.remove("hidden");
    } else {
        block.classList.add("hidden");
        const checkbox = document.getElementById("age-confirm-checkbox");
        if (checkbox) checkbox.checked = false; // скидаємо, щоб не залишалось "зайве" підтвердження
    }
}

function renderCart() {
    const container = document.getElementById('cart-items-container');
    const totalEl = document.getElementById('cart-total-price');
    const countEl = document.getElementById('cart-count');
    const bookingTotal = document.getElementById('total-price'); 

    if(!container) return;

    container.innerHTML = '';
    
    if (cart.length === 0) {
        const message = getRandomEmptyMessage();
        container.innerHTML = `<p class="empty-msg">${message}</p>`;
        if(countEl) { countEl.innerText = '0'; countEl.style.display = 'none'; }
        if(totalEl) totalEl.innerText = '0 грн';
        if(bookingTotal) bookingTotal.innerText = '0';
        updateAgeConfirmVisibility();
        return;
    }

    cart.forEach((item, index) => {
        const itemHTML = `
            <div class="cart-item">
                <div class="cart-item-info">
                    <h4>${item.device}</h4>
                    <p>${item.duration} год. / ${item.persons} ос.</p>
                </div>
                <div style="text-align: right;">
                    <div style="color: #00F0FF; font-weight: bold;">${item.price} грн</div>
                    <div class="cart-item-remove" onclick="removeFromCart(${index})">Видалити</div>
                </div>
            </div>
        `;
        container.innerHTML += itemHTML;
    });

    if(totalEl) totalEl.innerText = totalPrice + ' грн';
    if(countEl) { countEl.innerText = cart.length; countEl.style.display = ''; }
    if(bookingTotal) bookingTotal.innerText = totalPrice; 

    updateAgeConfirmVisibility();
}

// === Додавання товару ===
function addToCart(device, duration, persons, price) {
    cart.push({ device, duration, persons, price });
    totalPrice += price;
    renderCart(); 
    toggleCart(); 
}

// === Видалення товару ===
function removeFromCart(index) {
    totalPrice -= cart[index].price;
    cart.splice(index, 1); 
    renderCart();
}

// === Повна очистка ===
function clearCart() {
    cart = [];
    totalPrice = 0;
    renderCart();
}

// === Логіка карток (ціни, кнопки) ===
document.querySelectorAll(".card-v2").forEach(card => {
  const priceSpan = card.querySelector(".price-display span");
  if (!priceSpan) return; 

  // Беремо "справжню" ціну з єдиного джерела CLUB_PRICES за id картки.
  // Якщо картки немає в CLUB_PRICES (напр. нова картка) — використовуємо
  // data-one / data-two як запасний варіант.
  let baseOne, baseTwo;
  switch (card.id) {
    case 'ps5-card':
      baseOne = CLUB_PRICES.ps5.one;
      baseTwo = CLUB_PRICES.ps5.two;
      break;
    case 'vip-card':
      baseOne = CLUB_PRICES.vip;
      baseTwo = CLUB_PRICES.vip;
      break;
    case 'psvr-card':
      baseOne = CLUB_PRICES.psvr2;
      baseTwo = CLUB_PRICES.psvr2;
      break;
    case 'oculus-card':
      baseOne = CLUB_PRICES.oculus;
      baseTwo = CLUB_PRICES.oculus;
      break;
    default:
      baseOne = +priceSpan.dataset.one || 0;
      baseTwo = +priceSpan.dataset.two || baseOne;
  }

  priceSpan.innerText = baseOne;

  let hours = 1;
  let players = 1;

  function updateCardPrice() {
    const currentPrice = players === 1 ? baseOne * hours : baseTwo * hours;
    priceSpan.innerText = currentPrice;
  }

  card.querySelectorAll(".btn-hour").forEach(btn => {
    btn.onclick = () => {
      card.querySelectorAll(".btn-hour").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      hours = parseInt(btn.textContent.trim());
      updateCardPrice();
    };
  });

  card.querySelectorAll(".player-option").forEach((btn, idx) => {
    btn.onclick = () => {
      card.querySelectorAll(".player-option").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      players = idx === 0 ? 1 : 2;
      updateCardPrice();
    };
  });

  const addBtn = card.querySelector(".btn-add");
  if(addBtn) {
      addBtn.onclick = () => {
        const device = card.querySelector("h3")?.innerText || "Послуга";
        const price = players === 1 ? baseOne * hours : baseTwo * hours;
        addToCart(device, hours, players, price);
      };
  }
});

// === Відкрити модальне вікно ===
function openModal() {
  if (cart.length === 0) {
    showNotification("Корзина порожня. Додайте товари перед бронюванням!", "warning");
    return;
  }
  const modal = document.getElementById("dateTimeModal");
  const particles = document.getElementById("particles-js");

  if (modal) {
    modal.style.display = "flex";
    document.body.style.overflow = "hidden"; 
    if(particles) particles.style.display = "none"; 
    updateAgeConfirmVisibility();
  }
}

// === Закрити модальне вікно ===
function closeModal() {
  const modal = document.getElementById("dateTimeModal");
  const particles = document.getElementById("particles-js"); 

  if (modal) {
    modal.style.display = "none";
    document.body.style.overflow = ""; 
    if(particles) particles.style.display = "block"; 
  }
}

// === Клік поза модальним вікном ===
window.addEventListener("click", (e) => {
  const modal = document.getElementById("dateTimeModal");
  if (e.target === modal) {
    closeModal();
  }
});

// === Відправка бронювання НА ТВІЙ СЕРВЕР ===
async function submitOrder() {
  if (isSubmitting) return;

  const date = document.getElementById("date")?.value;
  const time = document.getElementById("time")?.value;
  const name = document.getElementById("name")?.value || "Не вказано";
  const phone = document.getElementById("phone")?.value || "Не вказано";
  const comment = document.getElementById("comment")?.value || "Немає";

  if (!date || !time) {
    showNotification("Будь ласка, оберіть дату та час!", "warning"); return;
    return;
  }

  if (cart.length === 0) {
    showNotification("Корзина порожня!", "warning"); return;
    return;
  }

  // Перевірка підтвердження віку (10+) для товарів з VR
  const vrKeywords = ["VR", "VIP", "Oculus"];
  const hasVrItem = cart.some(item =>
    vrKeywords.some(keyword => item.device.toLowerCase().includes(keyword.toLowerCase()))
  );
  const ageCheckbox = document.getElementById("age-confirm-checkbox");

  if (hasVrItem && ageCheckbox && !ageCheckbox.checked) {
    showNotification("Будь ласка, підтвердіть, що всім гравцям VR є 10 років або більше!", "warning");
    return;
  }

  isSubmitting = true;
  const submitBtn = document.querySelector(".cyber-btn.confirm");
  if(submitBtn) submitBtn.innerText = "ВІДПРАВКА...";

  try {
    const orderData = {
      cart: cart,
      totalPrice: totalPrice,
      date: date,
      time: time,
      name: name,
      phone: phone,
      comment: comment
    };

    
   // Звертаємося до нашого бекенду на Render
    const response = await fetch('https://level-vr-club.onrender.com/api/book', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(orderData)
    });

const data = await response.json();

    if (data.success) {
      // --- УВАГА: Заміни "level_vr_bot" на реальний юзернейм твого бота! ---
      const botUsername = "priwetabot"; 
      const orderId = data.orderId;

      showNotification(`✅ Бронювання #${orderId} успішно створено!`, "success");
      const userWantsBot = await showConfirm(`Перейти до Telegram-бота та отримати квиток із підтвердженням?`);
      
      if (userWantsBot) {
         // Перекидаємо клієнта в бота з його унікальним номером замовлення
         window.open(`https://t.me/${botUsername}?start=order_${orderId}`, '_blank');
      }

      clearCart(); 
      closeModal(); 
    } else {
      // ТУТ БУЛА ПОМИЛКА: не вистачало цього рядка і дужок нижче
      throw new Error(data.message || "Помилка обробки на сервері");
    }

  } catch (error) {
    console.error("❌ Помилка відправки:", error);
    showNotification(`Помилка: ${error.message}`, "error");
  } finally {
    isSubmitting = false;
    if(submitBtn) submitBtn.innerText = "ПІДТВЕРДИТИ";
  }
}