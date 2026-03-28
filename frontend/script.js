const searchParams = new URLSearchParams(window.location.search);
const EMBEDDED_MODE = searchParams.get("embedded") === "1";
const BUSINESS_ID =
  searchParams.get("business_id") ||
  window.VonzaWidgetConfig?.businessId ||
  "";
const WEBSITE_URL =
  searchParams.get("website_url") ||
  window.VonzaWidgetConfig?.websiteUrl ||
  "";
const conversationHistory = [];

function addToHistory(role, content) {
  conversationHistory.push({
    role,
    content
  });

  if (conversationHistory.length > 12) {
    conversationHistory.splice(0, conversationHistory.length - 12);
  }
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function appendMessage(chat, role, text, options = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}${options.typing ? " typing" : ""}`;

  const avatar = role === "user" ? "You" : "AI";
  const label = role === "user" ? "You" : "Assistant";
  const body = options.typing
    ? `<div class="typing-dots"><span></span><span></span><span></span></div>`
    : `<p>${escapeHtml(text)}</p>`;

  wrapper.innerHTML = `
    <div class="avatar">${avatar}</div>
    <div class="bubble">
      <p class="message-label">${label}</p>
      ${body}
    </div>
  `;

  chat.appendChild(wrapper);
  chat.scrollTop = chat.scrollHeight;
  return wrapper;
}

async function sendMessage() {
  const input = document.getElementById("input");
  const chat = document.getElementById("chat");
  const button = document.getElementById("send-button");

  const message = input.value.trim();
  const historySnapshot = conversationHistory.slice(-6);

  if (!message) return;

  if (!BUSINESS_ID && !WEBSITE_URL) {
    console.error("Vonza assistant configuration error: missing business_id and website_url");
    appendMessage(
      chat,
      "bot",
      "This assistant is not configured yet. Please add a valid business ID or website URL to the embed script."
    );
    return;
  }

  appendMessage(chat, "user", message);
  input.value = "";
  button.disabled = true;

  const loading = appendMessage(chat, "bot", "", { typing: true });

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message,
        business_id: BUSINESS_ID,
        website_url: WEBSITE_URL,
        history: historySnapshot
      })
    });

    const data = await res.json();

    loading.remove();

    if (!res.ok) {
      console.error("Vonza assistant backend error:", data.error || "Request failed");
      appendMessage(chat, "bot", data.error || "Request failed");
      return;
    }

    appendMessage(chat, "bot", data.reply);
    addToHistory("user", message);
    addToHistory("assistant", data.reply);
  } catch (err) {
    console.error("Vonza assistant request failed:", err);
    loading.remove();
    appendMessage(chat, "bot", "Error connecting to server");
  } finally {
    button.disabled = false;
    input.focus();
  }
}

document.getElementById("input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

if (EMBEDDED_MODE) {
  document.body.classList.add("embedded");
}

if ("serviceWorker" in navigator && !EMBEDDED_MODE) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("/service-worker.js");
    } catch (error) {
      console.error("Service worker registration failed:", error);
    }
  });
}
