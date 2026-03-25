const STORAGE_KEY = "zy_chatbot_v1";

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, String(v));
  });
  children.forEach((c) => node.appendChild(c));
  return node;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function formatTime(d = new Date()) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function createWidget() {
  const existing = document.querySelector(".zy-chatbot-launcher");
  if (existing) return;

  const initial =
    loadState() || ({
      messages: [
        {
          role: "assistant",
          content:
            "Yo. I’m your ZYNERGY coach. Tell me what you’re working on today (workout, nutrition, sleep) and I’ll give you a tight plan.",
          at: Date.now(),
        },
      ],
    });

  const launcher = el(
    "button",
    {
      class: "zy-chatbot-launcher",
      type: "button",
      "aria-label": "Open coach chat",
    },
    [el("div", { class: "zy-chatbot-face", text: "Z" }), el("div", { class: "zy-chatbot-dot" })]
  );

  const panel = el("section", {
    class: "zy-chatbot-panel zy-chatbot-hidden",
    role: "dialog",
    "aria-label": "Coach chat",
  });

  const header = el("header", { class: "zy-chatbot-header" });
  const title = el("div", { class: "zy-chatbot-title" }, [
    el("div", { class: "zy-chatbot-avatar", text: "Z" }),
    el("div", {}, [
      el("strong", { text: "Coach Zynergy" }),
      el("span", { text: "Quick advice • Groq powered" }),
    ]),
  ]);
  const closeBtn = el("button", { class: "zy-chatbot-close", type: "button", text: "Close" });
  header.appendChild(title);
  header.appendChild(closeBtn);

  const messagesWrap = el("div", { class: "zy-chatbot-messages" });
  const typing = el("div", { class: "zy-chatbot-typing zy-chatbot-hidden", text: "Coach is typing…" });
  const composer = el("form", { class: "zy-chatbot-composer" });
  const input = el("input", {
    class: "zy-chatbot-input",
    type: "text",
    placeholder: "Ask something…",
    autocomplete: "off",
  });
  const sendBtn = el("button", { class: "zy-chatbot-send", type: "submit", text: "Send" });
  composer.appendChild(input);
  composer.appendChild(sendBtn);

  panel.appendChild(header);
  panel.appendChild(messagesWrap);
  panel.appendChild(el("div", {}, [typing]));
  panel.appendChild(composer);

  const state = initial;

  function render() {
    messagesWrap.innerHTML = "";
    state.messages.forEach((m) => {
      const who = m.role === "user" ? "You" : "Coach";
      const item = el("div", { class: `zy-msg ${m.role === "user" ? "user" : "bot"}` }, [
        el("div", { class: "meta", text: `${who} • ${formatTime(new Date(m.at || Date.now()))}` }),
        el("div", { class: "zy-bubble", text: m.content || "" }),
      ]);
      messagesWrap.appendChild(item);
    });
    messagesWrap.scrollTop = messagesWrap.scrollHeight;
  }

  async function send(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;

    state.messages.push({ role: "user", content: trimmed, at: Date.now() });
    saveState(state);
    render();

    typing.classList.remove("zy-chatbot-hidden");
    input.disabled = true;
    sendBtn.disabled = true;

    try {
      const apiMessages = [
        {
          role: "system",
          content:
            "You are ZYNERGY's witty, motivating gym coach. Keep replies concise, actionable, and supportive. Prefer bullets for plans. No long essays.",
        },
        ...state.messages.map((m) => ({
          role: m.role === "user" ? "user" : "assistant",
          content: m.content,
        })),
      ];

      const res = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages,
          temperature: 0.8,
          max_completion_tokens: 512,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const reply = (data && data.reply) || "I didn’t get a reply. Try again.";

      state.messages.push({ role: "assistant", content: reply, at: Date.now() });
      saveState(state);
      render();
    } catch {
      state.messages.push({
        role: "assistant",
        content:
          "I couldn’t reach the coach server. Start it with `npm run dev` and make sure your `GROQ_API_KEY` is set.",
        at: Date.now(),
      });
      saveState(state);
      render();
    } finally {
      typing.classList.add("zy-chatbot-hidden");
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  function open() {
    panel.classList.remove("zy-chatbot-hidden");
    launcher.setAttribute("aria-expanded", "true");
    input.focus();
    render();
  }

  function close() {
    panel.classList.add("zy-chatbot-hidden");
    launcher.setAttribute("aria-expanded", "false");
  }

  launcher.addEventListener("click", () => {
    if (panel.classList.contains("zy-chatbot-hidden")) open();
    else close();
  });

  closeBtn.addEventListener("click", close);

  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value;
    input.value = "";
    send(v);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.classList.contains("zy-chatbot-hidden")) close();
  });

  document.body.appendChild(panel);
  document.body.appendChild(launcher);
  render();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", createWidget);
} else {
  createWidget();
}

