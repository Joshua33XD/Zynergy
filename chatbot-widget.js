const STORAGE_KEY = "zy_chatbot_v2";

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else {
      node.setAttribute(key, String(value));
    }
  });
  children.forEach((child) => node.appendChild(child));
  return node;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore localStorage failures
  }
}

function normalizeHistory(coach, existingHistory) {
  if (!coach) return [];

  const conversation = Array.isArray(existingHistory)
    ? existingHistory.filter(
        (entry) =>
          entry &&
          typeof entry.content === "string" &&
          (entry.role === "user" || entry.role === "assistant")
      )
    : [];

  return [{ role: "system", content: coach.systemPrompt }, ...conversation];
}

function coachLabel(coach) {
  return coach ? coach.name : "Coach Zynergy";
}

function createCoachArt(coach, className) {
  if (coach?.image) {
    return el("img", {
      class: `${className} zy-coach-art-image`,
      src: coach.image,
      alt: `${coach.name} portrait`,
      loading: "lazy",
    });
  }

  return el("div", { class: `${className} zy-coach-art-fallback`, text: coach?.icon || "Z" });
}

async function fetchCoaches() {
  const res = await fetch("/coaches");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  return Array.isArray(data?.coaches) ? data.coaches : [];
}

function createWidget() {
  const existing = document.querySelector(".zy-chatbot-launcher");
  if (existing) return;

  const savedState = loadState();
  let coaches = [];
  let selectedCoach = null;
  let history = [];

  const launcher = el(
    "button",
    {
      class: "zy-chatbot-launcher",
      type: "button",
      "aria-label": "Open coach chat",
      "aria-expanded": "false",
    },
    [el("div", { class: "zy-chatbot-face", text: "Z" }), el("div", { class: "zy-chatbot-dot" })]
  );

  const panel = el("section", {
    class: "zy-chatbot-panel zy-chatbot-hidden",
    role: "dialog",
    "aria-label": "Coach chat",
  });

  const header = el("header", { class: "zy-chatbot-header" });
  const avatar = el("div", { class: "zy-chatbot-avatar", text: "Z" });
  const titleText = el("div", {}, [
    el("strong", { text: "Choose your coach" }),
    el("span", { text: "Pick a style before you start chatting." }),
  ]);
  const title = el("div", { class: "zy-chatbot-title" }, [avatar, titleText]);

  const headerActions = el("div", { class: "zy-chatbot-actions" });
  const switchCoachBtn = el("button", {
    class: "zy-chatbot-switch",
    type: "button",
    text: "Switch coach",
  });
  const closeBtn = el("button", { class: "zy-chatbot-close", type: "button", text: "Close" });
  headerActions.appendChild(switchCoachBtn);
  headerActions.appendChild(closeBtn);

  header.appendChild(title);
  header.appendChild(headerActions);

  const body = el("div", { class: "zy-chatbot-body" });

  const selection = el("section", { class: "zy-chatbot-selection" }, [
    el("div", { class: "zy-chatbot-selection-copy" }, [
      el("p", { class: "zy-chatbot-kicker", text: "Coach lineup" }),
      el("h3", { text: "Choose the voice you want in your corner." }),
      el("p", {
        class: "zy-chatbot-selection-text",
        text: "Each coach uses a different system prompt. The All-Star blends all of them.",
      }),
    ]),
  ]);
  const selectionStatus = el("div", {
    class: "zy-chatbot-selection-status",
    text: "Loading coaches...",
  });
  const coachGrid = el("div", { class: "zy-coach-grid" });
  selection.appendChild(selectionStatus);
  selection.appendChild(coachGrid);

  const chatContainer = el("section", { class: "zy-chatbot-chat" });
  const messagesWrap = el("div", { class: "zy-chatbot-messages" });
  const typing = el("div", {
    class: "zy-chatbot-typing zy-chatbot-hidden",
    text: "Coach is typing...",
  });
  const notice = el("div", { class: "zy-chatbot-notice zy-chatbot-hidden" });
  const composer = el("form", { class: "zy-chatbot-composer" });
  const input = el("input", {
    class: "zy-chatbot-input",
    type: "text",
    placeholder: "Pick a coach to unlock chat",
    autocomplete: "off",
  });
  const sendBtn = el("button", { class: "zy-chatbot-send", type: "submit", text: "Send" });
  composer.appendChild(input);
  composer.appendChild(sendBtn);

  chatContainer.appendChild(messagesWrap);
  chatContainer.appendChild(typing);
  chatContainer.appendChild(notice);
  chatContainer.appendChild(composer);

  body.appendChild(selection);
  body.appendChild(chatContainer);
  panel.appendChild(header);
  panel.appendChild(body);

  function persist() {
    saveState({
      selectedCoachId: selectedCoach?.id || null,
      history,
    });
  }

  function setAvatarArt(coach) {
    avatar.classList.toggle("has-image", Boolean(coach?.image));
    avatar.textContent = coach?.image ? "" : coach?.icon || "Z";
    avatar.style.backgroundImage = coach?.image ? `url("${coach.image}")` : "";
  }

  function renderHeader() {
    if (selectedCoach) {
      titleText.children[0].textContent = selectedCoach.name;
      titleText.children[1].textContent = selectedCoach.blurb || "Coach selected";
      switchCoachBtn.style.display = "inline-flex";
      input.placeholder = `Ask ${selectedCoach.name} about training, food, or recovery`;
      input.disabled = false;
      sendBtn.disabled = false;
      setAvatarArt(selectedCoach);
    } else {
      titleText.children[0].textContent = "Choose your coach";
      titleText.children[1].textContent = "Pick a style before you start chatting.";
      switchCoachBtn.style.display = "none";
      input.placeholder = "Pick a coach to unlock chat";
      input.disabled = true;
      sendBtn.disabled = true;
      setAvatarArt(null);
    }
  }

  function renderMessages() {
    messagesWrap.innerHTML = "";

    const transcript = history.filter((entry) => entry.role !== "system");
    if (!transcript.length) {
      messagesWrap.appendChild(
        el("div", { class: "zy-chatbot-empty" }, [
          el("strong", {
            text: selectedCoach
              ? `${selectedCoach.name} is ready.`
              : "Select a coach to begin.",
          }),
          el("p", {
            text: selectedCoach
              ? "Ask for a workout split, nutrition fix, recovery advice, or a pep talk."
              : "Your chat history will start with that coach's system prompt.",
          }),
        ])
      );
      return;
    }

    transcript.forEach((entry) => {
      const isUser = entry.role === "user";
      const item = el("div", { class: `zy-msg ${isUser ? "user" : "bot"}` }, [
        el("div", { class: "meta", text: isUser ? "You" : coachLabel(selectedCoach) }),
        el("div", { class: "zy-bubble", text: entry.content || "" }),
      ]);
      messagesWrap.appendChild(item);
    });

    messagesWrap.scrollTop = messagesWrap.scrollHeight;
  }

  function showSelection() {
    selection.classList.remove("zy-chatbot-hidden");
    chatContainer.classList.remove("is-active");
    renderHeader();
    renderMessages();
  }

  function showChat() {
    selection.classList.add("zy-chatbot-hidden");
    chatContainer.classList.add("is-active");
    renderHeader();
    renderMessages();
  }

  function selectCoach(coach) {
    selectedCoach = coach;
    history = normalizeHistory(selectedCoach);
    persist();
    notice.classList.add("zy-chatbot-hidden");
    notice.textContent = "";
    showChat();
    input.focus();
  }

  function switchCoach() {
    selectedCoach = null;
    history = [];
    persist();
    notice.classList.add("zy-chatbot-hidden");
    notice.textContent = "";
    showSelection();
  }

  function renderCoachCards() {
    coachGrid.innerHTML = "";

    if (!coaches.length) {
      selectionStatus.textContent = "No coaches available right now.";
      return;
    }

    selectionStatus.textContent = "Tap a coach to start a fresh conversation.";

    coaches.forEach((coach) => {
      const card = el(
        "button",
        {
          class: "zy-coach-card",
          type: "button",
          onClick: () => selectCoach(coach),
          "aria-label": `Choose ${coach.name}`,
        },
        [
          createCoachArt(coach, "zy-coach-card-art"),
          el("div", { class: "zy-coach-card-copy" }, [
            el("strong", { text: coach.name }),
            el("p", { text: coach.blurb || "Coach ready" }),
          ]),
        ]
      );

      coachGrid.appendChild(card);
    });
  }

  async function bootstrapCoaches() {
    try {
      coaches = await fetchCoaches();
      renderCoachCards();

      if (savedState?.selectedCoachId) {
        selectedCoach = coaches.find((coach) => coach.id === savedState.selectedCoachId) || null;
        history = selectedCoach ? normalizeHistory(selectedCoach, savedState.history) : [];
      }

      if (selectedCoach) {
        showChat();
      } else {
        showSelection();
      }

      persist();
    } catch {
      selectionStatus.textContent =
        "Could not load coaches. Make sure the app is running through the Node server.";
      coachGrid.innerHTML = "";
      showSelection();
    }
  }

  async function send(text) {
    const trimmed = (text || "").trim();
    if (!trimmed || !selectedCoach) return;

    notice.classList.add("zy-chatbot-hidden");
    notice.textContent = "";

    if (!history.length) {
      history = [{ role: "system", content: selectedCoach.systemPrompt }];
    }

    history.push({ role: "user", content: trimmed });
    persist();
    renderMessages();

    typing.classList.remove("zy-chatbot-hidden");
    input.disabled = true;
    sendBtn.disabled = true;

    try {
      const res = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const reply = data?.reply?.trim() || "I did not get a reply. Try again.";

      history.push({ role: "assistant", content: reply });
      persist();
      renderMessages();
    } catch {
      notice.textContent =
        "I could not reach the coach server. Start it with `npm run dev` and make sure `GROQ_API_KEY` is set.";
      notice.classList.remove("zy-chatbot-hidden");
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
    if (selectedCoach) input.focus();
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
  switchCoachBtn.addEventListener("click", switchCoach);

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value;
    input.value = "";
    send(value);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.classList.contains("zy-chatbot-hidden")) close();
  });

  document.body.appendChild(panel);
  document.body.appendChild(launcher);

  renderHeader();
  renderMessages();
  bootstrapCoaches();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", createWidget);
} else {
  createWidget();
}
