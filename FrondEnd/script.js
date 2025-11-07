// === Глобальні змінні ===
let cart = [];
let totalPrice = 0;
let isSubmitting = false;

// === Додавання до кошика ===
function addToCart(device, duration, persons, price) {
    const item = { device, duration, persons, price };
    cart.push(item);
    totalPrice += price;

    document.getElementById("total-price").innerText = totalPrice;

    alert(`${device} на ${duration} год(и) для ${persons} осіб додано до кошика. Загальна сума: ${totalPrice} грн.`);
}

// === Очищення кошика ===
function clearCart() {
    cart = [];
    totalPrice = 0;
    document.getElementById("total-price").innerText = totalPrice;
    alert("Корзина очищена!");
}

// === Відкрити модальне вікно ===
function openModal() {
    if (cart.length === 0) {
        alert("Корзина порожня. Додайте товари перед бронюванням!");
        return;
    }
    document.getElementById("dateTimeModal").style.display = "flex";
}

// === Закрити модальне вікно ===
function closeModal() {
    document.getElementById("dateTimeModal").style.display = "none";
}

// === Клік поза модальним вікном ===
window.onclick = function (event) {
    const modal = document.getElementById("dateTimeModal");
    if (event.target === modal) closeModal();
};

// === Відправка бронювання на сервер ===
async function submitOrder() {
    if (isSubmitting) return;

    const date = document.getElementById("date")?.value;
    const time = document.getElementById("time")?.value;
    const name = document.getElementById("name")?.value || "";
    const phone = document.getElementById("phone")?.value || "";
    const comment = document.getElementById("comment")?.value || "";

    if (!date || !time) {
        alert("Будь ласка, оберіть дату та час!");
        return;
    }

    if (cart.length === 0) {
        alert("Корзина порожня!");
        return;
    }

    isSubmitting = true;

    try {
        const response = await fetch("/api/book", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cart, totalPrice, date, time, name, phone, comment })
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.message || "Помилка при бронюванні");
        }

        alert("✅ Бронювання успішно надіслано!");

        // Очистка після бронювання
        cart = [];
        totalPrice = 0;
        document.getElementById("total-price").innerText = totalPrice;
        closeModal();
    } catch (error) {
        console.error("❌ Помилка:", error);
        alert(`Не вдалося надіслати бронювання: ${error.message}`);
    } finally {
        isSubmitting = false;
    }
}

// === Меню на мобільному ===
function toggleMenu(toggle) {
  const menu = document.getElementById("menu");
  toggle.classList.toggle("active");
  menu.classList.toggle("open");
}


window.addEventListener("resize", () => {
    const menu = document.getElementById("menu");
    if (window.innerWidth > 768) menu.style.display = "flex";
    else menu.style.display = "none";
});

// === Скролл до "Про нас" ===
document.getElementById("scrollToAbout").addEventListener("click", function () {
    document.getElementById("about").scrollIntoView({ behavior: "smooth" });
});

// === Автоматичне прокручування списку ігор ===
let scrollPosition = 0;
const gamesList = document.querySelector(".games-list");
const cardWidth = 210;

function scrollLeft() {
    scrollPosition = Math.max(0, scrollPosition - cardWidth * 2);
    gamesList.style.transform = `translateX(-${scrollPosition}px)`;
}

function scrollRight() {
    const maxScroll = gamesList.scrollWidth - gamesList.clientWidth;
    scrollPosition = Math.min(maxScroll, scrollPosition + cardWidth * 2);
    gamesList.style.transform = `translateX(-${scrollPosition}px)`;
}

// === Автоповернення на верх ===
window.scrollTo(0, 0);
window.history.replaceState(null, null, " ");

const menuToggle = document.getElementById('menuToggle');
const menu = document.getElementById('menu');

menuToggle.addEventListener('click', () => {
  menu.classList.toggle('active');
  menuToggle.classList.toggle('active');
});

// закриття при кліку на пункт
document.querySelectorAll('#menu a').forEach(link => {
  link.addEventListener('click', () => {
    menu.classList.remove('active');
    menuToggle.classList.remove('active');
  });
});
// отримуємо елементи
const modal = document.getElementById('dateTimeModal');
const closeBtn = document.querySelector('.close-btn');

// функція відкриття
function openModal() {
  modal.style.display = 'block';
  document.body.style.overflow = 'hidden'; // щоб сторінка не скролилась під час модалки
}

// функція закриття
function closeModal() {
  modal.style.display = 'none';
  document.body.style.overflow = ''; // повертаємо скрол
}

// закриття при кліку на "X"
closeBtn.addEventListener('click', closeModal);

// закриття при кліку поза модалкою
window.addEventListener('click', (e) => {
  if (e.target === modal) {
    closeModal();
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.querySelector(".menu-toggle");
  const menu = document.getElementById("menu");

  if (!toggle || !menu) return; // Захист від зависання

  toggle.addEventListener("click", () => {
    toggle.classList.toggle("active");
    menu.classList.toggle("open");
  });

  // Закривати меню при кліку на посилання
  document.querySelectorAll(".menu a").forEach(link => {
    link.addEventListener("click", () => {
      toggle.classList.remove("active");
      menu.classList.remove("open");
    });
  });
});
