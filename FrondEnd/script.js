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
    });

    menu.querySelectorAll("a").forEach(link => {
      link.addEventListener("click", () => {
        menu.classList.remove("active");
        menuToggle.classList.remove("active");
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
        if(countEl) countEl.innerText = '0';
        if(totalEl) totalEl.innerText = '0 грн';
        if(bookingTotal) bookingTotal.innerText = '0';
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
    if(countEl) countEl.innerText = cart.length;
    if(bookingTotal) bookingTotal.innerText = totalPrice; 
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

  const baseOne = +priceSpan.dataset.one || 0;
  const baseTwo = +priceSpan.dataset.two || baseOne; 

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
    alert("Корзина порожня. Додайте товари перед бронюванням!");
    return;
  }
  const modal = document.getElementById("dateTimeModal");
  const particles = document.getElementById("particles-js");

  if (modal) {
    modal.style.display = "flex";
    document.body.style.overflow = "hidden"; 
    if(particles) particles.style.display = "none"; 
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
    alert("Будь ласка, оберіть дату та час!");
    return;
  }

  if (cart.length === 0) {
    alert("Корзина порожня!");
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

    // Звертаємося до нашого бекенду
    const response = await fetch('http://localhost:10000/api/book', {
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

      const userWantsBot = confirm(`✅ Бронювання #${orderId} успішно створено!\n\nНатисніть "ОК", щоб перейти в нашого Telegram-бота та отримати квиток із підтвердженням.`);
      
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
    alert(`Помилка: ${error.message}. Перевір, чи працює сервер!`);
  } finally {
    isSubmitting = false;
    if(submitBtn) submitBtn.innerText = "ПІДТВЕРДИТИ";
  }
}