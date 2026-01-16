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
  const modal = document.getElementById("dateTimeModal");
  if (modal) {
    modal.style.display = "flex";
    document.body.style.overflow = "hidden"; // блокуємо скрол
  }
}

// === Закрити модальне вікно ===
function closeModal() {
  const modal = document.getElementById("dateTimeModal");
  if (modal) {
    modal.style.display = "none";
    document.body.style.overflow = ""; // повертаємо скрол
  }
}

// === Клік поза модальним вікном ===
window.addEventListener("click", (e) => {
  const modal = document.getElementById("dateTimeModal");
  if (e.target === modal) {
    closeModal();
  }
});

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

// === Скролл до "Про нас" ===
document.addEventListener("DOMContentLoaded", () => {
  const scrollBtn = document.getElementById("scrollToAbout");
  if (scrollBtn) {
    scrollBtn.addEventListener("click", () => {
      document.getElementById("about").scrollIntoView({ behavior: "smooth" });
    });
  }

  // === Меню (бургер) ===
  const menuToggle = document.querySelector(".menu-toggle");
  const menu = document.querySelector(".menu");

  if (menuToggle && menu) {
    menuToggle.addEventListener("click", () => {
      menu.classList.toggle("active");
      menuToggle.classList.toggle("active");
    });

    // Закриваємо при кліку на пункт
    menu.querySelectorAll("a").forEach(link => {
      link.addEventListener("click", () => {
        menu.classList.remove("active");
        menuToggle.classList.remove("active");
      });
    });

    // Закриваємо при кліку поза меню
    document.addEventListener("click", (e) => {
      if (!menu.contains(e.target) && !menuToggle.contains(e.target)) {
        menu.classList.remove("active");
        menuToggle.classList.remove("active");
      }
    });
  }
});