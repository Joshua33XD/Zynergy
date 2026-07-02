const STORAGE_KEY = "zy_chatbot_v2";

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
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


