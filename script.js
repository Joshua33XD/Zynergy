import { createClient } from "https://esm.sh/@supabase/supabase-js";

const supabase = createClient(
  "https://wamikmqjlwnfohaqnfpc.supabase.co",
  "sb_publishable_X39Ew0pP1Dm8rLisK-1lIw_9xjldWfn"
);

// Helper function to get user info from session
async function getUserInfo() {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session || !session.user) return null;

  return {
    user_id: session.user.id,
    username:
      session.user.user_metadata?.full_name ||
      session.user.email?.split("@")[0] ||
      "User",
  };
}

// Helper function for upsert with fallback logic
async function upsertWithFallback(tableName, data, conflictColumns) {
  let { data: result, error } = await supabase.from(tableName).upsert(data);

  if (error && error.message?.includes("onConflict")) {
    const retry = await supabase
      .from(tableName)
      .upsert(data, { onConflict: conflictColumns });
    result = retry.data;
    error = retry.error;
  }

  if (
    error &&
    (error.code === "23505" || error.message?.includes("duplicate"))
  ) {
    const conflictCols = conflictColumns.split(",").map((col) =>
      col.trim().replace(/"/g, "")
    );
    const conflictConditions = conflictCols.map((col) => ({
      column: col,
      value: data[col] !== undefined ? data[col] : data[`"${col}"`],
    }));

    let query = supabase.from(tableName).select(conflictCols[0]);
    conflictConditions.forEach(({ column, value }) => {
      query = query.eq(column, value);
    });
    const { data: existing } = await query.single();

    if (existing) {
      let updateQuery = supabase.from(tableName).update(data);
      conflictConditions.forEach(({ column, value }) => {
        updateQuery = updateQuery.eq(column, value);
      });
      const updateResult = await updateQuery;
      result = updateResult.data;
      error = updateResult.error;
    } else {
      const insertResult = await supabase.from(tableName).insert(data);
      result = insertResult.data;
      error = insertResult.error;
    }
  }

  return { data: result, error };
}

function handleError(error, tableName, user_id, date) {
  const isDuplicate =
    error.code === "23505" ||
    error.message?.toLowerCase().includes("duplicate key");
  const isRLSError =
    error.message?.toLowerCase().includes("row-level security") ||
    error.message?.toLowerCase().includes("permission denied") ||
    error.code === "42501" ||
    error.message
      ?.toLowerCase()
      .includes("new row violates row-level security policy");

  if (isDuplicate) {
    return `Duplicate: you already have an entry for ${date}. Error: ${error.message}`;
  } else if (isRLSError) {
    return `RLS Error: ${error.message}\n\nUser ID: ${user_id}\n\nCheck your Supabase RLS policies for '${tableName}'.`;
  } else {
    return `Save failed: ${error.message}`;
  }
}

const uiState = { setCount: 0, sessionXp: 0 };
const mealCaptureState = {};
const gamificationState = {
  dailyMissions: [],
  completedMissionKeys: new Set(),
  badges: [],
  leaderboardLastRank: null,
};
const workoutPlannerState = {
  activeSplit: null,
  splitHistory: [],
  currentPlan: null,
  manualTemplates: [],
  workoutSets: [],
  pendingSwap: null,
  selectedTemplateId: null,
};

const SPLIT_DAY_ORDER = [
  { dayOfWeek: 1, label: "Monday", shortLabel: "Mon" },
  { dayOfWeek: 2, label: "Tuesday", shortLabel: "Tue" },
  { dayOfWeek: 3, label: "Wednesday", shortLabel: "Wed" },
  { dayOfWeek: 4, label: "Thursday", shortLabel: "Thu" },
  { dayOfWeek: 5, label: "Friday", shortLabel: "Fri" },
  { dayOfWeek: 6, label: "Saturday", shortLabel: "Sat" },
  { dayOfWeek: 7, label: "Sunday", shortLabel: "Sun" },
];

const SPLIT_LABEL_OPTIONS = ["Rest", "Push", "Pull", "Legs", "Upper", "Lower", "Custom"];

function formatElapsedMs(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hours = Math.floor(minutes / 60);
  const displayMinutes = minutes % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(displayMinutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(displayMinutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getCurrentLocalTimeValue() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function stopMealTimer(prefix, { updateTimeInput = false } = {}) {
  const state = mealCaptureState[prefix];
  if (!state || !state.isRunning) return;
  state.elapsedBeforeStart += Date.now() - state.startedAt;
  state.isRunning = false;
  state.startedAt = null;
  if (state.intervalId) {
    window.clearInterval(state.intervalId);
    state.intervalId = null;
  }
  if (updateTimeInput && state.timeInput && !state.timeInput.value) {
    state.timeInput.value = getCurrentLocalTimeValue();
  }
  state.statusEl.textContent = `Last session: ${formatElapsedMs(state.elapsedBeforeStart)}.`;
}

function resetMealTimer(prefix) {
  const state = mealCaptureState[prefix];
  if (!state) return;
  stopMealTimer(prefix);
  state.elapsedBeforeStart = 0;
  state.displayEl.textContent = "00:00";
  state.statusEl.textContent = "Timer reset.";
}

function setupMealCapture(prefix) {
  const photoInput = document.getElementById(`${prefix}MealPhoto`);
  const photoPreviewWrap = document.getElementById(`${prefix}MealPhotoPreviewWrap`);
  const photoPreview = document.getElementById(`${prefix}MealPhotoPreview`);
  const displayEl = document.getElementById(`${prefix}MealTimerDisplay`);
  const statusEl = document.getElementById(`${prefix}MealTimerStatus`);
  const startBtn = document.getElementById(`${prefix}MealTimerStart`);
  const stopBtn = document.getElementById(`${prefix}MealTimerStop`);
  const resetBtn = document.getElementById(`${prefix}MealTimerReset`);
  const timeInput = document.getElementById(`${prefix}MealTime`);
  const remainingInput = document.getElementById(`${prefix}RemainingFood`);

  if (!photoInput || !photoPreviewWrap || !photoPreview || !displayEl || !statusEl || !startBtn || !stopBtn || !resetBtn) {
    return;
  }

  mealCaptureState[prefix] = {
    intervalId: null,
    startedAt: null,
    elapsedBeforeStart: 0,
    isRunning: false,
    photoInput,
    photoPreviewWrap,
    photoPreview,
    displayEl,
    statusEl,
    timeInput,
    remainingInput,
  };

  const renderTimer = () => {
    const state = mealCaptureState[prefix];
    const elapsed = state.isRunning
      ? state.elapsedBeforeStart + (Date.now() - state.startedAt)
      : state.elapsedBeforeStart;
    state.displayEl.textContent = formatElapsedMs(elapsed);
  };

  photoInput.addEventListener("change", () => {
    const file = photoInput.files?.[0];
    const previousObjectUrl = photoPreview.dataset.objectUrl;
    if (previousObjectUrl) {
      URL.revokeObjectURL(previousObjectUrl);
      delete photoPreview.dataset.objectUrl;
    }
    if (!file) {
      photoPreview.removeAttribute("src");
      photoPreviewWrap.classList.add("hidden");
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    photoPreview.src = objectUrl;
    photoPreview.dataset.objectUrl = objectUrl;
    photoPreviewWrap.classList.remove("hidden");
  });

  startBtn.addEventListener("click", () => {
    const state = mealCaptureState[prefix];
    if (state.isRunning) return;
    state.isRunning = true;
    state.startedAt = Date.now();
    state.statusEl.textContent = `Started at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
    renderTimer();
    state.intervalId = window.setInterval(renderTimer, 1000);
  });

  stopBtn.addEventListener("click", () => {
    stopMealTimer(prefix, { updateTimeInput: true });
    renderTimer();
  });

  resetBtn.addEventListener("click", () => {
    resetMealTimer(prefix);
  });

  renderTimer();
}

function getMealCaptureSummary(prefix) {
  const state = mealCaptureState[prefix];
  if (!state) return [];

  const parts = [];
  const photoFile = state.photoInput?.files?.[0];
  const timeAte = state.timeInput?.value?.trim();
  const remainingFood = state.remainingInput?.value?.trim();
  const elapsed = state.isRunning
    ? state.elapsedBeforeStart + (Date.now() - state.startedAt)
    : state.elapsedBeforeStart;

  if (photoFile) parts.push(`Photo: ${photoFile.name}`);
  if (timeAte) parts.push(`Time ate: ${timeAte}`);
  if (elapsed > 0) parts.push(`Eating timer: ${formatElapsedMs(elapsed)}`);
  if (remainingFood) parts.push(`Remaining food: ${remainingFood}`);
  return parts;
}

function combineNoteParts(parts) {
  return parts.map((part) => part?.trim()).filter(Boolean).join(" | ") || null;
}

// Simple client-side level curve based on XP
function getLevelFromXp(xp) {
  const thresholds = [
    { level: 1, name: "Rookie", min: 0 },
    { level: 5, name: "Grind Starter", min: 250 },
    { level: 10, name: "Iron Disciple", min: 750 },
    { level: 15, name: "Plate Stacker", min: 1500 },
    { level: 20, name: "Volume Slayer", min: 2500 },
  ];
  let current = thresholds[0];
  for (const t of thresholds) {
    if (xp >= t.min && t.min >= current.min) current = t;
  }
  return current;
}

async function getOrCreateUserProfile() {
  const userInfo = await getUserInfo();
  if (!userInfo) return null;
  const { user_id, username } = userInfo;

  let { data, error } = await supabase
    .from("user_profile")
    .select("*")
    .eq("user_id", user_id)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    console.error("Profile load failed:", error);
    return null;
  }

  if (!data) {
    const { data: inserted, error: insertError } = await supabase
      .from("user_profile")
      .insert({ user_id, username, xp: 0 })
      .select()
      .single();
    if (insertError) {
      console.error("Profile create failed:", insertError);
      return null;
    }
    data = inserted;
  }

  return data;
}

async function addXp(delta, source = "general") {
  const userInfo = await getUserInfo();
  if (!userInfo || !delta) return;
  const { user_id, username } = userInfo;

  // Load current XP, then upsert with the new total
  let currentXp = 0;
  const { data: existing, error: fetchError } = await supabase
    .from("user_profile")
    .select("xp")
    .eq("user_id", user_id)
    .maybeSingle();

  if (fetchError && fetchError.code !== "PGRST116") {
    console.error("XP fetch failed:", fetchError);
    return;
  }

  if (existing && typeof existing.xp === "number") {
    currentXp = existing.xp;
  }

  const { error: upsertError } = await upsertWithFallback(
    "user_profile",
    { user_id, username, xp: currentXp + delta },
    "user_id"
  );

  if (upsertError) {
    console.error("XP update failed:", upsertError);
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const { error: eventError } = await supabase.from("xp_events").insert({
    user_id,
    username,
    event_date: today,
    xp_delta: delta,
    source,
  });
  if (eventError) {
    // Keep XP flow resilient even if analytics table is not yet provisioned.
    console.warn("xp_events insert skipped:", eventError.message);
  }
}

function getDailyMissionCatalog() {
  return [
    { key: "log_workout", label: "Log 1 workout", xp: 20 },
    { key: "log_nutrition", label: "Log 1 nutrition entry", xp: 15 },
    { key: "log_sleep", label: "Log sleep entry", xp: 10 },
    { key: "post_challenge", label: "Post 1 challenge", xp: 25 },
  ];
}

function getMissionStorageKey() {
  return `zynergy_daily_missions_${new Date().toISOString().split("T")[0]}`;
}

function loadMissionProgress() {
  const raw = localStorage.getItem(getMissionStorageKey());
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveMissionProgress(setValue) {
  localStorage.setItem(getMissionStorageKey(), JSON.stringify(Array.from(setValue)));
}

function markMissionComplete(key, { suppressXpPop = false } = {}) {
  if (!key) return;
  const mission = gamificationState.dailyMissions.find((m) => m.key === key);
  if (!mission) return;
  if (gamificationState.completedMissionKeys.has(key)) return;
  gamificationState.completedMissionKeys.add(key);
  saveMissionProgress(gamificationState.completedMissionKeys);
  if (!suppressXpPop) {
    showXpPop(`+${mission.xp} XP (Mission)`);
    addXp(mission.xp, `mission:${key}`);
  }
  renderMissionBoard();

  const allDone =
    gamificationState.dailyMissions.length > 0 &&
    gamificationState.dailyMissions.every((m) =>
      gamificationState.completedMissionKeys.has(m.key)
    );
  if (allDone && !gamificationState.completedMissionKeys.has("__daily_bonus__")) {
    gamificationState.completedMissionKeys.add("__daily_bonus__");
    saveMissionProgress(gamificationState.completedMissionKeys);
    showXpPop("+25 XP Daily Bonus");
    addXp(25, "daily_bonus");
    maybeNotify("Daily bonus unlocked", "All missions complete. +25 XP awarded.");
  }
}

function renderMissionBoard() {
  const missionList = document.getElementById("missionList");
  if (!missionList) return;

  missionList.replaceChildren();
  gamificationState.dailyMissions.forEach((mission) => {
    const done = gamificationState.completedMissionKeys.has(mission.key);
    const li = document.createElement("li");
    li.classList.toggle("done", done);
    const text = document.createElement("span");
    text.textContent = mission.label;
    const btn = document.createElement("button");
    btn.className = "mission-toggle";
    btn.type = "button";
    btn.dataset.key = mission.key;
    btn.dataset.xp = String(mission.xp);
    btn.textContent = done ? "Done" : "Pending";
    btn.addEventListener("click", () => markMissionComplete(mission.key));
    li.append(text, btn);
    missionList.appendChild(li);
  });

  const doneCount = gamificationState.dailyMissions.filter((m) =>
    gamificationState.completedMissionKeys.has(m.key)
  ).length;
  const pct = gamificationState.dailyMissions.length
    ? Math.round((doneCount / gamificationState.dailyMissions.length) * 100)
    : 0;
  const missionPct = document.getElementById("missionPct");
  if (missionPct) missionPct.textContent = `${pct}%`;
  animateMeterById("missionMeter", pct);
  const bonusLabel = document.getElementById("missionBonusLabel");
  if (bonusLabel) {
    const bonusDone = gamificationState.completedMissionKeys.has("__daily_bonus__");
    bonusLabel.textContent = bonusDone
      ? "Daily bonus claimed: +25 XP."
      : "Daily bonus: complete all missions for +25 XP.";
  }
}

// â”€â”€â”€ Local exercise catalog â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Common movements and their primary muscle group. Used instead of Wger for
// exercise discovery and selection.
const LOCAL_EXERCISES = [
  { id: "bb_bench_press", name: "Barbell Bench Press", muscle: "Chest", description: "Flat bench press with barbell for overall chest strength." },
  { id: "db_bench_press", name: "Dumbbell Bench Press", muscle: "Chest", description: "Flat dumbbell press to train each side independently." },
  { id: "incline_db_press", name: "Incline Dumbbell Press", muscle: "Chest", description: "Incline variation to emphasize upper chest." },
  { id: "push_up", name: "Push-up", muscle: "Chest", description: "Bodyweight horizontal press for chest, shoulders, and triceps." },

  { id: "bb_squat", name: "Barbell Back Squat", muscle: "Legs", description: "Heavy compound for quads, glutes, and core." },
  { id: "front_squat", name: "Front Squat", muscle: "Legs", description: "Quad-focused squat with the bar in front rack position." },
  { id: "romanian_deadlift", name: "Romanian Deadlift", muscle: "Legs", description: "Hip-hinge for hamstrings and glutes." },
  { id: "leg_press", name: "Leg Press", muscle: "Legs", description: "Machine press for high-volume leg work." },

  { id: "conventional_deadlift", name: "Conventional Deadlift", muscle: "Back", description: "Full-body pull emphasizing posterior chain and back." },
  { id: "bb_row", name: "Barbell Row", muscle: "Back", description: "Horizontal pull for lats and mid-back." },
  { id: "seated_cable_row", name: "Seated Cable Row", muscle: "Back", description: "Controlled row variation for back thickness." },
  { id: "lat_pulldown", name: "Lat Pulldown", muscle: "Back", description: "Vertical pull to build lats and upper back." },

  { id: "ohp", name: "Overhead Press", muscle: "Shoulders", description: "Standing press for shoulders and triceps." },
  { id: "lateral_raise", name: "Dumbbell Lateral Raise", muscle: "Shoulders", description: "Isolation movement for side delts." },
  { id: "rear_delt_fly", name: "Rear Delt Fly", muscle: "Shoulders", description: "Fly variation to hit rear delts and upper back." },

  { id: "bb_curl", name: "Barbell Curl", muscle: "Biceps", description: "Straight-bar curl for overall biceps mass." },
  { id: "db_curl", name: "Alternating Dumbbell Curl", muscle: "Biceps", description: "Unilateral curl for biceps and forearms." },
  { id: "hammer_curl", name: "Hammer Curl", muscle: "Biceps", description: "Neutral-grip curl for brachialis and forearms." },

  { id: "skullcrusher", name: "Skullcrusher", muscle: "Triceps", description: "Lying triceps extension for long head strength." },
  { id: "rope_pushdown", name: "Cable Rope Pushdown", muscle: "Triceps", description: "Cable isolation for triceps lockout strength." },
  { id: "dip", name: "Parallel Bar Dip", muscle: "Triceps", description: "Bodyweight dip for chest and triceps." },
];

// â”€â”€â”€ wger / external state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// We still use wger for nutrition ingredients, but workouts use LOCAL_EXERCISES.
const wgerState = {
  exercises: [],       // last exercise search results
  ingredients: [],     // last ingredient search results
  muscleLookup: {},    // id â†’ name, loaded once on init
  workoutReady: false,
  nutritionReady: false,
};

// â”€â”€â”€ UI helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showXpPop(text) {
  const xpPop = document.getElementById("xpPop");
  if (!xpPop) return;
  xpPop.textContent = text;
  xpPop.classList.remove("show");
  void xpPop.offsetWidth;
  xpPop.classList.add("show");
}

function showToast(message, type = "info") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    Object.assign(container.style, {
      position: "fixed",
      bottom: "80px",
      left: "50%",
      transform: "translateX(-50%)",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      zIndex: "9999",
      pointerEvents: "none",
      width: "max-content",
      maxWidth: "90vw"
    });
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  Object.assign(toast.style, {
    background: type === "error" ? "#e74c3c" : type === "success" ? "#2ecc71" : "#3498db",
    color: "#ffffff",
    padding: "10px 16px",
    borderRadius: "8px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
    fontSize: "14px",
    fontWeight: "500",
    opacity: "0",
    transition: "opacity 0.3s ease, transform 0.3s ease",
    transform: "translateY(10px)",
    textAlign: "center"
  });
  toast.textContent = message;

  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";
  });

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function animateMeterById(id, percent) {
  const meter = document.getElementById(id);
  if (!meter) return;
  meter.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function animateNumber(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = Number(el.textContent) || 0;
  const steps = 15;
  let count = 0;
  const delta = (target - start) / steps;
  const timer = setInterval(() => {
    count += 1;
    el.textContent = Math.round(start + delta * count);
    if (count >= steps) {
      clearInterval(timer);
      el.textContent = String(target);
    }
  }, 18);
}

function maybeNotify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted")
    return;
  new Notification(title, { body });
}

function applyTheme(themeName) {
  if (!themeName || themeName === "default") {
    document.body.removeAttribute("data-theme");
    return;
  }
  document.body.setAttribute("data-theme", themeName);
}

function stripHtml(input) {
  if (!input) return "";
  const parser = new DOMParser();
  const doc = parser.parseFromString(input, "text/html");
  return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}

function formatMacro(label, value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return `${label}: ${value}g`;
}

function renderApiError(statusEl, listEl, message) {
  if (statusEl) statusEl.textContent = message;
  if (listEl) listEl.replaceChildren();
}

function showLoginRequiredMessage(targetId, message = "Please login to view data.") {
  const target = document.getElementById(targetId);
  if (!target) return;
  target.textContent = message;
}

function capitalizeFirst(text) {
  if (!text) return "";
  return text[0].toUpperCase() + text.slice(1).toLowerCase();
}

function getTodayDateString() {
  return new Date().toISOString().split("T")[0];
}

async function apiRequest(url, options = {}) {
  const {
    method = "GET",
    body,
    requireAuth = true,
  } = options;

  const headers = {};
  const userInfo = await getUserInfo();

  if (requireAuth && !userInfo) {
    throw new Error("AUTH_REQUIRED");
  }

  if (userInfo) {
    headers["x-user-id"] = userInfo.user_id;
    headers["x-username"] = userInfo.username;
  }

  const fetchOptions = {
    method,
    headers,
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url, fetchOptions);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.error || `Request failed with status ${response.status}.`;
    throw new Error(message);
  }

  return { data: payload, userInfo };
}

function buildDefaultSplitDays() {
  return SPLIT_DAY_ORDER.map((day, index) => ({
    dayOfWeek: day.dayOfWeek,
    weekdayName: day.label,
    isRest: index === 6,
    workoutLabel: index === 6 ? "Rest" : "",
    notes: "",
  }));
}

function getSplitPresetForDay(day) {
  if (day.isRest) return "Rest";
  if (!day.workoutLabel) return "";
  return SPLIT_LABEL_OPTIONS.includes(day.workoutLabel) ? day.workoutLabel : "Custom";
}

function createSplitDayRow(day, rowIndex) {
  const row = document.createElement("article");
  row.className = "split-day-row";
  row.dataset.dayOfWeek = String(day.dayOfWeek);

  const title = document.createElement("div");
  title.className = "split-day-label";
  title.textContent = SPLIT_DAY_ORDER[rowIndex]?.shortLabel || day.weekdayName || `Day ${rowIndex + 1}`;

  const selectWrap = document.createElement("div");
  selectWrap.className = "split-day-field";

  const select = document.createElement("select");
  select.className = "split-day-select";
  SPLIT_LABEL_OPTIONS.forEach((optionLabel) => {
    const option = document.createElement("option");
    option.value = optionLabel;
    option.textContent = optionLabel;
    if (getSplitPresetForDay(day) === optionLabel) option.selected = true;
    select.appendChild(option);
  });

  const customInput = document.createElement("input");
  customInput.type = "text";
  customInput.className = "split-day-custom";
  customInput.placeholder = "Custom workout label";
  customInput.value =
    getSplitPresetForDay(day) === "Custom" ? day.workoutLabel || "" : "";
  customInput.hidden = getSplitPresetForDay(day) !== "Custom";

  select.addEventListener("change", () => {
    customInput.hidden = select.value !== "Custom";
    if (select.value !== "Custom") {
      customInput.value = "";
    }
  });

  selectWrap.append(select, customInput);

  const notesWrap = document.createElement("div");
  notesWrap.className = "split-day-field";

  const notesInput = document.createElement("input");
  notesInput.type = "text";
  notesInput.className = "split-day-notes";
  notesInput.placeholder = "Optional notes";
  notesInput.value = day.notes || "";
  notesWrap.appendChild(notesInput);

  row.append(title, selectWrap, notesWrap);
  return row;
}

function renderSplitRows(containerId, days = buildDefaultSplitDays()) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.replaceChildren();

  const normalizedDays = SPLIT_DAY_ORDER.map((meta) => {
    const match = (days || []).find((day) => Number(day.dayOfWeek) === meta.dayOfWeek);
    return match || {
      dayOfWeek: meta.dayOfWeek,
      weekdayName: meta.label,
      isRest: false,
      workoutLabel: "",
      notes: "",
    };
  });

  normalizedDays.forEach((day, index) => {
    container.appendChild(createSplitDayRow(day, index));
  });
}

function collectSplitDays(containerId) {
  const container = document.getElementById(containerId);
  if (!container) {
    throw new Error("Split rows are unavailable.");
  }

  const rows = [...container.querySelectorAll(".split-day-row")];
  return rows.map((row) => {
    const dayOfWeek = Number(row.dataset.dayOfWeek);
    const select = row.querySelector(".split-day-select");
    const customInput = row.querySelector(".split-day-custom");
    const notesInput = row.querySelector(".split-day-notes");
    const preset = select?.value || "";
    const customLabel = customInput?.value.trim() || "";

    if (preset === "Custom" && !customLabel) {
      throw new Error("Each Custom split day needs a workout label.");
    }

    const isRest = preset === "Rest";
    return {
      dayOfWeek,
      isRest,
      workoutLabel: isRest ? "Rest" : preset === "Custom" ? customLabel : preset,
      notes: notesInput?.value.trim() || "",
    };
  });
}

function setPlanBadge(source, text) {
  const badge = document.getElementById("todayPlanSourceBadge");
  if (!badge) return;
  badge.dataset.source = source || "none";
  badge.textContent = text;
}

function renderActiveSplitSummary(split) {
  const summary = document.getElementById("activeSplitSummary");
  const builderForm = document.getElementById("splitBuilderForm");
  const plannerStatus = document.getElementById("splitPlannerStatus");
  const editBtn = document.getElementById("editSplitBtn");
  const historyBtn = document.getElementById("viewSplitHistoryBtn");

  if (!summary || !builderForm || !plannerStatus || !editBtn || !historyBtn) return;

  if (!split) {
    summary.classList.add("hidden");
    builderForm.classList.remove("hidden");
    plannerStatus.textContent = "No active split found yet. Build your first 7-day split below.";
    editBtn.classList.add("hidden");
    historyBtn.classList.add("hidden");
    return;
  }

  builderForm.classList.add("hidden");
  summary.classList.remove("hidden");
  plannerStatus.textContent = `Active split: ${split.name} (v${split.versionNo})`;
  editBtn.classList.remove("hidden");
  historyBtn.classList.remove("hidden");

  const list = document.createElement("div");
  list.className = "split-summary-grid";

  (split.days || []).forEach((day) => {
    const item = document.createElement("article");
    item.className = "split-summary-item";

    const weekday = document.createElement("strong");
    weekday.textContent = day.shortLabel || day.weekdayName || `Day ${day.dayOfWeek}`;

    const label = document.createElement("span");
    label.textContent = day.isRest ? "Rest" : day.workoutLabel || "Custom";

    item.append(weekday, label);

    if (day.notes) {
      const notes = document.createElement("small");
      notes.textContent = day.notes;
      item.appendChild(notes);
    }

    list.appendChild(item);
  });

  summary.replaceChildren(list);
}

function renderSplitHistoryDrawer(versions) {
  const list = document.getElementById("splitHistoryList");
  const status = document.getElementById("splitHistoryStatus");
  if (!list || !status) return;

  list.replaceChildren();

  if (!versions.length) {
    status.textContent = "No split history yet.";
    return;
  }

  status.textContent = `${versions.length} version${versions.length === 1 ? "" : "s"} saved.`;

  versions.forEach((version) => {
    const card = document.createElement("article");
    card.className = "split-history-item";

    const heading = document.createElement("div");
    heading.className = "split-history-head";

    const title = document.createElement("strong");
    title.textContent = `${version.name} · v${version.versionNo}`;

    const date = document.createElement("span");
    date.textContent = version.activatedAt
      ? new Date(version.activatedAt).toLocaleString()
      : "Activation date unavailable";

    heading.append(title, date);
    card.appendChild(heading);

    if (version.historyRecord?.changeSummary) {
      const summary = document.createElement("p");
      summary.className = "muted";
      summary.textContent = version.historyRecord.changeSummary;
      card.appendChild(summary);
    }

    const days = document.createElement("div");
    days.className = "split-history-days";
    (version.days || []).forEach((day) => {
      const pill = document.createElement("span");
      pill.className = "split-pill";
      pill.textContent = `${day.shortLabel}: ${day.isRest ? "Rest" : day.workoutLabel}`;
      days.appendChild(pill);
    });

    card.appendChild(days);
    list.appendChild(card);
  });
}

async function loadSplitPlanner() {
  const plannerCard = document.getElementById("splitPlannerCard");
  if (!plannerCard) return;
  const splitNameInput = document.getElementById("splitNameInput");

  try {
    const [{ data: activeResponse }, { data: historyResponse }] = await Promise.all([
      apiRequest("/api/splits/active"),
      apiRequest("/api/splits/history"),
    ]);

    workoutPlannerState.activeSplit = activeResponse?.split || null;
    workoutPlannerState.splitHistory = historyResponse?.versions || [];

    if (splitNameInput && !workoutPlannerState.activeSplit) {
      splitNameInput.value = "My Split";
    }

    renderSplitRows(
      "splitBuilderRows",
      workoutPlannerState.activeSplit?.days || buildDefaultSplitDays()
    );
    renderActiveSplitSummary(workoutPlannerState.activeSplit);
    renderSplitHistoryDrawer(workoutPlannerState.splitHistory);
    await loadWorkoutPlan();
  } catch (error) {
    const plannerStatus = document.getElementById("splitPlannerStatus");
    if (plannerStatus) {
      plannerStatus.textContent =
        error.message === "AUTH_REQUIRED"
          ? "Sign in to load and save your workout split."
          : error.message;
    }
  }
}

async function createInitialSplit() {
  setButtonBusy("saveSplitBtn", true, "Save Split");
  try {
    const name = document.getElementById("splitNameInput")?.value.trim() || "My Split";
    const days = collectSplitDays("splitBuilderRows");
    await apiRequest("/api/splits", {
      method: "POST",
      body: { name, days },
    });
    showToast("Split saved. Version 1 is now active.", "success");
    await loadSplitPlanner();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setButtonBusy("saveSplitBtn", false, "Save Split");
  }
}

function openSplitEditor() {
  if (!workoutPlannerState.activeSplit) return;
  const modal = document.getElementById("splitEditorModal");
  const nameInput = document.getElementById("splitEditorName");
  const summaryInput = document.getElementById("splitChangeSummary");
  if (!modal || !nameInput || !summaryInput) return;

  nameInput.value = workoutPlannerState.activeSplit.name || "";
  summaryInput.value = "";
  renderSplitRows("splitEditorRows", workoutPlannerState.activeSplit.days || buildDefaultSplitDays());
  modal.classList.remove("hidden");
}

function closeSplitEditor() {
  document.getElementById("splitEditorModal")?.classList.add("hidden");
}

function openSplitHistoryDrawer() {
  document.getElementById("splitHistoryDrawer")?.classList.remove("hidden");
}

function closeSplitHistoryDrawer() {
  document.getElementById("splitHistoryDrawer")?.classList.add("hidden");
}

async function saveSplitEdit() {
  setButtonBusy("saveSplitEditBtn", true, "Save New Version");
  try {
    const name = document.getElementById("splitEditorName")?.value.trim() || workoutPlannerState.activeSplit?.name || "My Split";
    const changeSummary =
      document.getElementById("splitChangeSummary")?.value.trim() || "Split updated";
    const days = collectSplitDays("splitEditorRows");

    await apiRequest("/api/splits/active", {
      method: "PUT",
      body: { name, days, changeSummary },
    });

    closeSplitEditor();
    showToast("Split updated. A new version is now active.", "success");
    await loadSplitPlanner();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setButtonBusy("saveSplitEditBtn", false, "Save New Version");
  }
}

function renderWorkoutPlan(plan) {
  const label = document.getElementById("todayPlanLabel");
  const meta = document.getElementById("todayPlanMeta");
  if (!label || !meta) return;

  workoutPlannerState.currentPlan = plan;

  if (!plan || plan.source === "none") {
    setPlanBadge("none", "No plan");
    label.textContent = "No workout plan resolved yet.";
    meta.textContent = "Create a split to automatically fill today's workout.";
    return;
  }

  const badgeLabelMap = {
    override: "Override",
    swap: "Swap",
    split: "Split",
  };

  setPlanBadge(plan.source, badgeLabelMap[plan.source] || "Plan");
  label.textContent = plan.isRest ? "Rest day" : plan.workoutLabel || "Workout";

  const detailParts = [];
  if (plan.weekdayName) detailParts.push(plan.weekdayName);
  if (plan.splitName) detailParts.push(`${plan.splitName} v${plan.versionNo}`);
  if (plan.reason) detailParts.push(plan.reason);
  if (plan.notes) detailParts.push(plan.notes);
  meta.textContent = detailParts.join(" · ") || "Resolved for today.";
  updateOverrideStatus(plan);
  updateSwapStatus(plan);
}

async function loadWorkoutPlan(dateString = getTodayDateString()) {
  const label = document.getElementById("todayPlanLabel");
  if (!label) return;

  try {
    const { data } = await apiRequest(`/api/workouts/plan?date=${encodeURIComponent(dateString)}`);
    renderWorkoutPlan(data);
  } catch (error) {
    renderWorkoutPlan(null);
    const meta = document.getElementById("todayPlanMeta");
    if (meta) meta.textContent = error.message === "AUTH_REQUIRED" ? "Sign in to resolve a daily plan." : error.message;
  }
}

function getOverrideSelection() {
  const select = document.getElementById("overrideLabelSelect");
  const customInput = document.getElementById("overrideCustomLabel");
  const selected = select?.value || "";
  const customValue = customInput?.value.trim() || "";

  if (selected === "Custom" && !customValue) {
    throw new Error("Custom overrides need a workout label.");
  }

  const label = selected === "Custom" ? customValue : selected;
  return {
    isRest: label === "Rest",
    workoutLabel: label,
  };
}

async function applyOverride() {
  setButtonBusy("applyOverrideBtn", true, "Apply Only For This Date");
  const status = document.getElementById("overrideStatus");
  try {
    const dateInput = document.getElementById("overrideDateInput");
    const reason = document.getElementById("overrideReason")?.value.trim() || "";
    const overrideDate = dateInput?.value || getTodayDateString();
    const selection = getOverrideSelection();

    await apiRequest("/api/workouts/override", {
      method: "PUT",
      body: {
        overrideDate,
        isRest: selection.isRest,
        workoutLabel: selection.workoutLabel,
        reason,
      },
    });

    if (status) status.textContent = `Override saved for ${overrideDate}.`;
    showToast("Override applied for that date.", "success");
    await loadWorkoutPlan(overrideDate);
  } catch (error) {
    if (status) status.textContent = error.message;
    showToast(error.message, "error");
  } finally {
    setButtonBusy("applyOverrideBtn", false, "Apply Only For This Date");
  }
}

async function clearOverride() {
  setButtonBusy("clearOverrideBtn", true, "Remove Override");
  const status = document.getElementById("overrideStatus");
  try {
    const dateInput = document.getElementById("overrideDateInput");
    const overrideDate = dateInput?.value || getTodayDateString();
    await apiRequest(`/api/workouts/override/${overrideDate}`, { method: "DELETE" });
    if (status) status.textContent = `Override cleared for ${overrideDate}.`;
    showToast("Override removed.", "success");
    await loadWorkoutPlan(overrideDate);
  } catch (error) {
    if (status) status.textContent = error.message;
    showToast(error.message, "error");
  } finally {
    setButtonBusy("clearOverrideBtn", false, "Remove Override");
  }
}

function updateOverrideStatus(plan) {
  const card = document.getElementById("dailyOverrideCard");
  const status = document.getElementById("overrideStatus");
  if (!card || !status) return;

  if (plan?.source === "override") {
    card.classList.add("override-active");
    status.textContent = "Override active for this date.";
  } else {
    card.classList.remove("override-active");
  }
}

function getSwapSelection() {
  const select = document.getElementById("swapTargetLabel");
  const customInput = document.getElementById("swapCustomLabel");
  const selected = select?.value || "";
  const customValue = customInput?.value.trim() || "";

  if (selected === "Custom" && !customValue) {
    throw new Error("Custom swaps need a workout label.");
  }

  const label = selected === "Custom" ? customValue : selected;
  return {
    isRest: label === "Rest",
    toWorkout: label,
  };
}

async function createSwap() {
  setButtonBusy("swapCreateBtn", true, "Create Swap");
  const status = document.getElementById("swapStatus");
  try {
    const plan = workoutPlannerState.currentPlan;
    if (!plan || plan.source === "none") {
      throw new Error("No plan found to swap yet.");
    }
    const selection = getSwapSelection();
    const targetDate = getTodayDateString();
    const fromWorkout = plan.workoutLabel || "Workout";

    const { data } = await apiRequest("/api/workouts/swap", {
      method: "POST",
      body: {
        targetDate,
        fromWorkout,
        toWorkout: selection.toWorkout,
        isRest: selection.isRest,
      },
    });

    workoutPlannerState.pendingSwap = data?.swap || null;
    if (status) status.textContent = "Swap created. Confirm to apply.";
    showToast("Swap created. Confirm when ready.", "success");
    updateSwapActions();
  } catch (error) {
    if (status) status.textContent = error.message;
    showToast(error.message, "error");
  } finally {
    setButtonBusy("swapCreateBtn", false, "Create Swap");
  }
}

function openSwapConfirmModal() {
  const modal = document.getElementById("swapConfirmModal");
  const details = document.getElementById("swapConfirmDetails");
  if (!modal || !details) return;
  const pending = workoutPlannerState.pendingSwap;
  if (!pending) return;

  details.textContent = `Swap ${pending.fromWorkout} to ${pending.toWorkout} for ${pending.targetDate}.`;
  modal.classList.remove("hidden");
}

function closeSwapConfirmModal() {
  document.getElementById("swapConfirmModal")?.classList.add("hidden");
}

async function confirmSwap() {
  const pending = workoutPlannerState.pendingSwap;
  if (!pending) return;
  setButtonBusy("confirmSwapActionBtn", true, "Confirm Swap");
  try {
    await apiRequest(`/api/workouts/swap/${pending.id}/confirm`, { method: "POST" });
    closeSwapConfirmModal();
    workoutPlannerState.pendingSwap = null;
    showToast("Swap confirmed.", "success");
    await loadWorkoutPlan(pending.targetDate);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setButtonBusy("confirmSwapActionBtn", false, "Confirm Swap");
  }
}

async function createReverseSwap() {
  const plan = workoutPlannerState.currentPlan;
  if (!plan || plan.source !== "swap") {
    showToast("No confirmed swap to reverse yet.", "error");
    return;
  }
  setButtonBusy("swapReverseBtn", true, "Create Reverse Swap");
  try {
    const targetDate = getTodayDateString();
    const { data } = await apiRequest("/api/workouts/swap", {
      method: "POST",
      body: {
        targetDate,
        fromWorkout: plan.workoutLabel || "Workout",
        toWorkout: plan.fromWorkout || "Workout",
        isRest: plan.fromWorkout === "Rest",
      },
    });
    workoutPlannerState.pendingSwap = data?.swap || null;
    showToast("Reverse swap created. Confirm to apply.", "success");
    updateSwapActions();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setButtonBusy("swapReverseBtn", false, "Create Reverse Swap");
  }
}

function updateSwapActions() {
  const confirmBtn = document.getElementById("swapConfirmBtn");
  const reverseBtn = document.getElementById("swapReverseBtn");
  if (confirmBtn) {
    confirmBtn.classList.toggle("hidden", !workoutPlannerState.pendingSwap);
  }
  if (reverseBtn) {
    reverseBtn.classList.toggle("hidden", workoutPlannerState.currentPlan?.source !== "swap");
  }
}

function updateSwapStatus(plan) {
  const card = document.getElementById("swapCard");
  const status = document.getElementById("swapStatus");
  if (!card || !status) return;

  card.classList.remove("swap-pending", "swap-confirmed");

  if (workoutPlannerState.pendingSwap) {
    card.classList.add("swap-pending");
    status.textContent = "Swap pending confirmation.";
    updateSwapActions();
    return;
  }

  if (plan?.source === "swap") {
    card.classList.add("swap-confirmed");
    status.textContent = "Swap confirmed for today.";
    updateSwapActions();
    return;
  }

  status.textContent = "No swap created yet.";
  updateSwapActions();
}

function renderManualTemplateOptions() {
  const select = document.getElementById("manualTemplateSelect");
  const chips = document.getElementById("manualTemplateChips");
  if (!select || !chips) return;

  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a saved template";
  select.appendChild(placeholder);

  chips.replaceChildren();

  workoutPlannerState.manualTemplates.forEach((template) => {
    const option = document.createElement("option");
    option.value = template.id;
    option.textContent = template.name;
    select.appendChild(option);

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "split-pill split-pill-button";
    chip.textContent = template.name;
    chip.addEventListener("click", () => applyManualTemplate(template.id));
    chips.appendChild(chip);
  });
}

function fillManualWorkoutForm(template) {
  if (!template) return;
  const fieldMap = {
    manualTemplateName: template.name || "",
    manualExercise: template.exercise || "",
    manualSets: template.sets ?? "",
    manualReps: template.reps ?? "",
    manualWeight: template.weight ?? "",
    manualNotes: template.notes || "",
  };

  Object.entries(fieldMap).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.value = value;
  });
}

function applyManualTemplate(templateId) {
  const template = workoutPlannerState.manualTemplates.find((entry) => entry.id === templateId);
  if (!template) return;
  workoutPlannerState.selectedTemplateId = template.id;
  const select = document.getElementById("manualTemplateSelect");
  if (select) select.value = template.id;
  fillManualWorkoutForm(template);
  showToast(`Loaded template: ${template.name}`, "success");
}

async function loadManualTemplates() {
  const status = document.getElementById("manualWorkoutStatus");
  try {
    const { data } = await apiRequest("/api/workouts/manual/templates");
    workoutPlannerState.manualTemplates = data?.templates || [];
    renderManualTemplateOptions();
    if (status && workoutPlannerState.manualTemplates.length) {
      status.textContent = `${workoutPlannerState.manualTemplates.length} template${workoutPlannerState.manualTemplates.length === 1 ? "" : "s"} ready to reuse.`;
    }
  } catch (error) {
    if (status) {
      status.textContent =
        error.message === "AUTH_REQUIRED"
          ? "Sign in to load your saved manual templates."
          : error.message;
    }
  }
}

function collectManualWorkoutForm() {
  const payload = {
    name: document.getElementById("manualTemplateName")?.value.trim() || "",
    exercise: document.getElementById("manualExercise")?.value.trim() || "",
    sets: Number(document.getElementById("manualSets")?.value || 0),
    reps: Number(document.getElementById("manualReps")?.value || 0),
    weight: Number(document.getElementById("manualWeight")?.value || 0),
    notes: document.getElementById("manualNotes")?.value.trim() || "",
    templateId: workoutPlannerState.selectedTemplateId || null,
  };

  if (!payload.exercise) {
    throw new Error("Exercise name is required.");
  }
  if (payload.sets <= 0 || payload.reps <= 0) {
    throw new Error("Sets and reps must be greater than zero.");
  }
  if (payload.weight < 0) {
    throw new Error("Weight cannot be negative.");
  }

  return payload;
}

async function saveManualWorkoutTemplate() {
  setButtonBusy("manualSaveTemplateBtn", true, "Save As Template");
  try {
    const payload = collectManualWorkoutForm();
    const { data } = await apiRequest("/api/workouts/manual/template", {
      method: "POST",
      body: payload,
    });
    workoutPlannerState.selectedTemplateId = data?.template?.id || null;
    showToast("Template saved for future workouts.", "success");
    await loadManualTemplates();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setButtonBusy("manualSaveTemplateBtn", false, "Save As Template");
  }
}

async function saveManualWorkoutLog() {
  setButtonBusy("manualWorkoutLogBtn", true, "Log Workout");
  const status = document.getElementById("manualWorkoutStatus");
  try {
    const payload = collectManualWorkoutForm();
    const { userInfo } = await apiRequest("/api/workouts/manual/log", {
      method: "POST",
      body: payload,
    });

    const date = getTodayDateString();
    const summary = `${payload.exercise} (${payload.sets}x${payload.reps}${payload.weight ? ` @ ${payload.weight}kg` : ""})`;

    const { error } = await upsertWithFallback(
      "workout_daily",
      {
        user_id: userInfo.user_id,
        username: userInfo.username,
        date,
        workout_status: `Manual log: ${summary}`,
        workout_intensity: "Moderate",
        muscle_groups: [],
        energy_level: 3,
      },
      "user_id,date"
    );

    if (error) {
      throw new Error(handleError(error, "workout_daily", userInfo.user_id, date));
    }

    uiState.sessionXp += 30;
    animateNumber("sessionXp", uiState.sessionXp);
    animateMeterById("sessionXpMeter", Math.min(100, uiState.sessionXp));
    showXpPop("+30 XP");
    addXp(30);
    markMissionComplete("log_workout");
    showToast("Manual workout logged successfully.", "success");

    if (status) status.textContent = `Saved ${payload.exercise} for today.`;
    const workoutSaveStatus = document.getElementById("workoutSaveStatus");
    if (workoutSaveStatus) workoutSaveStatus.textContent = "Workout log saved/updated for today.";

    const challengeInput = document.getElementById("challengeExercise");
    if (challengeInput && !challengeInput.value) {
      challengeInput.value = payload.exercise;
    }
  } catch (error) {
    if (status) status.textContent = error.message;
    showToast(error.message, "error");
  } finally {
    setButtonBusy("manualWorkoutLogBtn", false, "Log Workout");
  }
}

function initializeWorkoutSets() {
  if (!workoutPlannerState.workoutSets.length) {
    workoutPlannerState.workoutSets = [
      { id: `set_${Date.now()}`, reps: "8", weight: "40" },
    ];
  }
  const setsInput = document.getElementById("wgerSets");
  if (setsInput) setsInput.value = String(workoutPlannerState.workoutSets.length);
  renderWorkoutSetRows();
}

function addWorkoutSetDraft() {
  workoutPlannerState.workoutSets.push({
    id: `set_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    reps: "8",
    weight: "0",
  });
  renderWorkoutSetRows();
}

function removeWorkoutSetDraft(setId) {
  workoutPlannerState.workoutSets = workoutPlannerState.workoutSets.filter((entry) => entry.id !== setId);
  if (!workoutPlannerState.workoutSets.length) {
    initializeWorkoutSets();
    return;
  }
  renderWorkoutSetRows();
}

function renderWorkoutSetRows() {
  const container = document.getElementById("workoutSetList");
  if (!container) return;

  container.replaceChildren();
  workoutPlannerState.workoutSets.forEach((setEntry, index) => {
    const row = document.createElement("div");
    row.className = "workout-set-row";

    const label = document.createElement("div");
    label.className = "workout-set-label";
    label.textContent = `Set ${index + 1}`;

    const repsWrap = document.createElement("label");
    repsWrap.className = "form-row";
    repsWrap.textContent = "Reps";
    const repsInput = document.createElement("input");
    repsInput.type = "number";
    repsInput.min = "1";
    repsInput.value = setEntry.reps;
    repsInput.addEventListener("input", () => {
      setEntry.reps = repsInput.value;
    });
    repsWrap.appendChild(repsInput);

    const weightWrap = document.createElement("label");
    weightWrap.className = "form-row";
    weightWrap.textContent = "Weight (kg)";
    const weightInput = document.createElement("input");
    weightInput.type = "number";
    weightInput.min = "0";
    weightInput.step = "0.5";
    weightInput.value = setEntry.weight;
    weightInput.addEventListener("input", () => {
      setEntry.weight = weightInput.value;
    });
    weightWrap.appendChild(weightInput);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "workout-set-remove";
    removeButton.textContent = "Remove";
    removeButton.disabled = workoutPlannerState.workoutSets.length === 1;
    removeButton.addEventListener("click", () => removeWorkoutSetDraft(setEntry.id));

    row.append(label, repsWrap, weightWrap, removeButton);
    container.appendChild(row);
  });
}

function getWorkoutSetSummary() {
  const normalizedSets = workoutPlannerState.workoutSets
    .map((entry) => ({
      reps: Number(entry.reps || 0),
      weight: Number(entry.weight || 0),
    }))
    .filter((entry) => entry.reps > 0);

  if (!normalizedSets.length) {
    return null;
  }

  const topSet = normalizedSets.reduce((currentTop, entry) => {
    if (!currentTop || entry.weight > currentTop.weight) return entry;
    return currentTop;
  }, null);

  return {
    sets: normalizedSets.length,
    reps: topSet?.reps || 0,
    weightKg: topSet?.weight || 0,
  };
}

// â”€â”€â”€ SELECT FILLERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function fillWgerExerciseSelect(exercises) {
  const select = document.getElementById("wgerExerciseSelect");
  if (!select) return;
  select.replaceChildren();

  if (!exercises.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No exercises found - try a different search";
    select.appendChild(opt);
    return;
  }

  exercises.forEach((ex, idx) => {
    const opt = document.createElement("option");
    opt.value = String(ex.id ?? idx);
    opt.textContent = ex.name;
    if (idx === 0) opt.selected = true;
    select.appendChild(opt);
  });
}

function fillWgerIngredientSelect(ingredients) {
  const select = document.getElementById("wgerIngredientSelect");
  if (!select) return;
  select.replaceChildren();

  if (!ingredients.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No ingredients found - try a different search";
    select.appendChild(opt);
    return;
  }

  ingredients.forEach((ing, idx) => {
    const opt = document.createElement("option");
    opt.value = String(ing.id ?? idx);
    opt.textContent = ing.name || "Unnamed ingredient";
    if (idx === 0) opt.selected = true;
    select.appendChild(opt);
  });
}

function fillWgerMuscleSelect(muscleLookup) {
  const select = document.getElementById("wgerMuscleFocus");
  if (!select) return;

  const previous = select.value || "";
  select.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "All muscle groups (optional)";
  placeholder.selected = true;
  select.appendChild(placeholder);

  Object.entries(muscleLookup)
    .sort(([, a], [, b]) => a.localeCompare(b))
    .forEach(([id, name]) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = name;
      if (previous && previous === opt.value) opt.selected = true;
      select.appendChild(opt);
    });
}

// â”€â”€â”€ EXERCISE SEARCH (local catalog) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Uses cached API results for exercise search.
async function runExerciseSearch() {
  const searchInput = document.getElementById("wgerExerciseSearch");
  const muscleSelect = document.getElementById("wgerMuscleFocus");
  const statusEl = document.getElementById("exerciseStatus");
  const listEl = document.getElementById("exercise-list");

  const query = searchInput?.value.trim();
  if (!query) {
    if (statusEl) statusEl.textContent = "Please type an exercise name to search.";
    return;
  }

  if (statusEl) statusEl.textContent = "Searching exercise catalog...";
  fillWgerExerciseSelect([]);
  if (listEl) renderExerciseSkeletons(listEl, 6);

  const muscleId = muscleSelect?.value || "";

  try {
    const params = new URLSearchParams({ q: query });
    if (muscleId) params.append("muscle", muscleId);
    const response = await fetch(`/api/exercises/search?${params.toString()}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || "Exercise search failed.");

    const exercises = Array.isArray(payload?.results) ? payload.results : [];
    const cached = Boolean(payload?.cached);

    wgerState.exercises = exercises;
    fillWgerExerciseSelect(exercises);

    if (listEl) {
      listEl.replaceChildren();
      exercises.slice(0, 20).forEach((ex) => {
        const card = document.createElement("article");
        card.className = "api-item";

        if (ex.image) {
          const img = document.createElement("img");
          img.className = "exercise-photo";
          img.alt = ex.name || "Exercise photo";
          img.loading = "lazy";
          img.src = ex.image;
          card.appendChild(img);
        } else {
          const thumb = document.createElement("div");
          thumb.className = "exercise-thumb";
          thumb.textContent = (ex.name || "?").charAt(0).toUpperCase();
          card.appendChild(thumb);
        }

        const title = document.createElement("h3");
        title.textContent = ex.name || "Exercise";
        const detail = document.createElement("p");
        detail.textContent = `${ex.muscle || "Unknown"} · ${ex.equipment || "Equipment"}`;

        card.append(title, detail);

        if (cached) {
          const tag = document.createElement("span");
          tag.className = "api-pill";
          tag.textContent = "Cached";
          card.appendChild(tag);
        }

        listEl.appendChild(card);
      });
    }

    if (statusEl) {
      statusEl.textContent = exercises.length
        ? `Found ${exercises.length} exercise(s) for "${query}".`
        : `No exercises found for "${query}". Try a different keyword.`;
    }
  } catch (error) {
    if (statusEl) statusEl.textContent = error.message || "Exercise search failed.";
    if (listEl) listEl.replaceChildren();
  }
}

function renderExerciseSkeletons(listEl, count) {
  listEl.replaceChildren();
  for (let i = 0; i < count; i += 1) {
    const card = document.createElement("article");
    card.className = "api-item exercise-skeleton";

    const shimmer = document.createElement("div");
    shimmer.className = "skeleton-box";

    const line = document.createElement("div");
    line.className = "skeleton-line";

    card.append(shimmer, line);
    listEl.appendChild(card);
  }
}

// â”€â”€â”€ INGREDIENT SEARCH (fixed) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Uses /ingredient/ with a live ?name= search param instead of scoring 8 items.
// Focus filter sorts results by macro content after fetching.
async function runIngredientSearch() {
  const searchInput = document.getElementById("wgerIngredientSearch");
  const focusSelect = document.getElementById("wgerFoodFocus");
  const statusEl = document.getElementById("nutritionStatus");
  const listEl = document.getElementById("nutrition-list");

  const query = searchInput?.value.trim();
  if (!query) {
    if (statusEl) statusEl.textContent = "Please type an ingredient name to search.";
    return;
  }

  if (statusEl) statusEl.textContent = "Searching ingredients...";
  fillWgerIngredientSelect([]);

  try {
    // FIX: Search by name with a generous limit so focus filter has enough data
    const url = `https://wger.de/api/v2/ingredient/?format=json&language=2&name=${encodeURIComponent(query)}&limit=50`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    let results = Array.isArray(data.results) ? data.results : [];

    // FIX: Apply focus sort AFTER fetching real search results
    const focus = focusSelect?.value;
    if (focus) {
      results = sortIngredientsByFocus(results, focus);
    }

    wgerState.ingredients = results;
    fillWgerIngredientSelect(results);

    // Render cards
    if (listEl) {
      listEl.replaceChildren();
      results.slice(0, 20).forEach((ing) => {
        const card = document.createElement("article");
        card.className = "api-item";

        const title = document.createElement("h3");
        title.textContent = ing.name || "Unnamed ingredient";

        const detail = document.createElement("p");
        detail.textContent = `Energy: ${ing.energy ?? "?"} kcal / 100g`;

        const pills = document.createElement("div");
        pills.className = "api-pill-row";

        const macros = [
          formatMacro("Protein", ing.protein),
          formatMacro("Carbs", ing.carbohydrates),
          formatMacro("Fat", ing.fat),
        ].filter(Boolean);

        if (!macros.length) {
          const fallback = document.createElement("span");
          fallback.className = "api-pill";
          fallback.textContent = "Macros unavailable";
          pills.appendChild(fallback);
        } else {
          macros.forEach((m) => {
            const pill = document.createElement("span");
            pill.className = "api-pill";
            pill.textContent = m;
            pills.appendChild(pill);
          });
        }

        card.append(title, detail, pills);
        listEl.appendChild(card);
      });
    }

    if (statusEl) {
      statusEl.textContent = results.length
        ? `Found ${results.length} ingredient(s) for "${query}"${focus ? ` sorted by ${focus}` : ""}.`
        : `No ingredients found for "${query}". Try a different keyword.`;
    }
  } catch (err) {
    renderApiError(statusEl, listEl, "Could not search ingredients. Check your connection.");
    console.error("Wger ingredient search failed:", err);
    wgerState.ingredients = [];
    fillWgerIngredientSelect([]);
  }
}

// â”€â”€â”€ SORTING HELPER (replaces the broken getIngredientsByFocus) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function sortIngredientsByFocus(ingredients, focus) {
  if (!focus) return ingredients;

  return [...ingredients].sort((a, b) => {
    const getScore = (ing) => {
      const protein = Number(ing.protein || 0);
      const carbs = Number(ing.carbohydrates || 0);
      const fat = Number(ing.fat || 0);
      const total = protein + carbs + fat || 1;

      if (focus === "protein") return protein;
      if (focus === "carbs") return carbs;
      if (focus === "fat") return fat;
      if (focus === "balanced") {
        const p = protein / total;
        const c = carbs / total;
        const f = fat / total;
        return 1 - (Math.abs(p - 0.33) + Math.abs(c - 0.33) + Math.abs(f - 0.34));
      }
      return 0;
    };
    return getScore(b) - getScore(a);
  });
}

// â”€â”€â”€ MUSCLE LOOKUP INIT (local) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Build muscle dropdown from LOCAL_EXERCISES (no external API).
async function loadMuscleLookup() {
  const muscles = Array.from(
    new Set(LOCAL_EXERCISES.map((ex) => ex.muscle).filter(Boolean))
  );
  wgerState.muscleLookup = muscles.reduce((acc, name) => {
    acc[name] = name;
    return acc;
  }, {});
  fillWgerMuscleSelect(wgerState.muscleLookup);
}

// â”€â”€â”€ FILTER SETUP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function setupWgerFilters() {
  const exerciseSearchBtn = document.getElementById("wgerExerciseSearchBtn");
  const exerciseSearchInput = document.getElementById("wgerExerciseSearch");
  const ingredientSearchBtn = document.getElementById("wgerIngredientSearchBtn");
  const ingredientSearchInput = document.getElementById("wgerIngredientSearch");
  const focusSelect = document.getElementById("wgerFoodFocus");

  // Re-sort current results when focus changes (no new API call needed)
  focusSelect?.addEventListener("change", () => {
    if (wgerState.ingredients.length) {
      const sorted = sortIngredientsByFocus(wgerState.ingredients, focusSelect.value);
      wgerState.ingredients = sorted;
      fillWgerIngredientSelect(sorted);
      const statusEl = document.getElementById("nutritionStatus");
      if (statusEl && focusSelect.value) {
        statusEl.textContent = `Results re-sorted by ${focusSelect.value}.`;
      }
    }
  });

  exerciseSearchBtn?.addEventListener("click", runExerciseSearch);
  exerciseSearchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runExerciseSearch(); }
  });

  ingredientSearchBtn?.addEventListener("click", runIngredientSearch);
  ingredientSearchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runIngredientSearch(); }
  });
}

// â”€â”€â”€ SOURCE MODE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function setSourceMode({ ready, wgerCardId, manualCardId, statusId, manualToggleId, readyText, fallbackText }) {
  const wgerCard = document.getElementById(wgerCardId);
  const manualCard = document.getElementById(manualCardId);
  const status = document.getElementById(statusId);
  const toggleBtn = document.getElementById(manualToggleId);

  if (status) status.textContent = ready ? readyText : fallbackText;
  if (!wgerCard || !manualCard) return;

  if (ready) {
    wgerCard.classList.remove("hidden");
    manualCard.classList.add("hidden");
    if (toggleBtn) toggleBtn.textContent = "Use Manual Logger";
  } else {
    wgerCard.classList.add("hidden");
    manualCard.classList.remove("hidden");
  }
}

// â”€â”€â”€ FEEDS INIT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// For workouts we now use local catalog; nutrition still calls Wger.
async function setupWgerFeeds() {
  await loadMuscleLookup();

  const wgerReady = Object.keys(wgerState.muscleLookup).length > 0;

  wgerState.workoutReady = wgerReady;
  wgerState.nutritionReady = wgerReady;

  setSourceMode({
    ready: wgerReady,
    wgerCardId: "wgerWorkoutCard",
    manualCardId: "manualWorkoutCard",
    statusId: "workoutSourceStatus",
    manualToggleId: "workoutManualToggle",
    readyText: "Exercise library ready. Search for an exercise to begin.",
    fallbackText: "Exercise library unavailable. Manual workout logger enabled.",
  });

  setSourceMode({
    ready: wgerReady,
    wgerCardId: "wgerNutritionCard",
    manualCardId: "manualNutritionCard",
    statusId: "nutritionSourceStatus",
    manualToggleId: "nutritionManualToggle",
    readyText: "Wger connected. Search for an ingredient to begin.",
    fallbackText: "Wger unavailable. Manual nutrition logger enabled.",
  });

  // Seed status labels
  const exerciseStatus = document.getElementById("exerciseStatus");
  const nutritionStatus = document.getElementById("nutritionStatus");
  if (exerciseStatus) exerciseStatus.textContent = "Type an exercise name and click Search.";
  if (nutritionStatus) nutritionStatus.textContent = "Type an ingredient name and click Search.";

  fillWgerExerciseSelect([]);
  fillWgerIngredientSelect([]);
}

// â”€â”€â”€ SAVE VIA WGER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function saveWorkoutViaWger() {
  setButtonBusy("wgerWorkoutSaveBtn", true, "Log Selected Workout");
  const statusLabel = document.getElementById("workoutSourceStatus");
  const userInfo = await getUserInfo();
  if (!userInfo) {
    if (statusLabel) statusLabel.textContent = "Login required before saving workout.";
    setButtonBusy("wgerWorkoutSaveBtn", false, "Log Selected Workout");
    showToast("You must be logged in to save workouts.", "error");
    return;
  }

  const muscleFocus = document.getElementById("wgerMuscleFocus")?.value || "";
  const exerciseSelect = document.getElementById("wgerExerciseSelect");
  const intensityRaw = document.getElementById("wgerWorkoutIntensity")?.value || "moderate";
  const setSummary = getWorkoutSetSummary();
  const sets = setSummary?.sets || Number(document.getElementById("wgerSets")?.value || 0);
  const reps = setSummary?.reps || 0;
  const weightKg = setSummary?.weightKg || 0;

  if (!exerciseSelect?.value || exerciseSelect.value === "") {
    if (statusLabel) statusLabel.textContent = "Select an exercise result before saving.";
    setButtonBusy("wgerWorkoutSaveBtn", false, "Log Selected Workout");
    showToast("Please search for and select an exercise first.", "error");
    return;
  }
  if (weightKg <= 0) {
    if (statusLabel) statusLabel.textContent = "Top set weight must be greater than 0kg.";
    setButtonBusy("wgerWorkoutSaveBtn", false, "Log Selected Workout");
    showToast("Please enter a top set weight greater than 0 kg.", "error");
    return;
  }
  if (sets <= 0 || reps <= 0) {
    if (statusLabel) statusLabel.textContent = "Sets and reps must be greater than 0.";
    setButtonBusy("wgerWorkoutSaveBtn", false, "Log Selected Workout");
    showToast("Sets and reps must be greater than 0.", "error");
    return;
  }

  const exercise = wgerState.exercises.find(
    (item) => String(item.id) === exerciseSelect.value
  );
  const exerciseName =
    exercise?.name ||
    exerciseSelect.options[exerciseSelect.selectedIndex]?.text ||
    "Exercise";
  const date = new Date().toISOString().split("T")[0];
  const intensity = capitalizeFirst(intensityRaw);
  const { user_id, username } = userInfo;

  // Derive a safe energy_level value from intensity so we still satisfy
  // the workout_daily check constraint without asking the user.
  const energy_level =
    intensityRaw === "light" ? 4 :
    intensityRaw === "intense" ? 2 :
    3;

  const { error } = await upsertWithFallback(
    "workout_daily",
    {
      user_id,
      username,
      date,
      workout_status: `Wger log: ${exerciseName} (${sets}x${reps} @ ${weightKg}kg)`,
      workout_intensity: intensity,
      muscle_groups: muscleFocus ? [wgerState.muscleLookup[muscleFocus] || muscleFocus] : [],
      energy_level,
    },
    "user_id,date"
  );

  if (error) {
    if (statusLabel) statusLabel.textContent = "Workout save failed. Check form and try again.";
    setButtonBusy("wgerWorkoutSaveBtn", false, "Log Selected Workout");
    showToast(handleError(error, "workout_daily", user_id, date), "error");
    return;
  }

  uiState.sessionXp += 30;
  animateNumber("sessionXp", uiState.sessionXp);
  animateMeterById("sessionXpMeter", Math.min(100, uiState.sessionXp));
  showXpPop("+30 XP");
  maybeNotify("Workout saved", `${exerciseName} saved through Wger.`);
  showToast("Workout saved successfully via Wger!", "success");

  // Prefill challenge exercise name for quick posting
  const challengeInput = document.getElementById("challengeExercise");
  if (challengeInput && !challengeInput.value) {
    challengeInput.value = exerciseName;
  }

  addXp(30);
  markMissionComplete("log_workout");
  if (statusLabel) statusLabel.textContent = "Workout saved to your daily log.";
  const workoutSaveStatus = document.getElementById("workoutSaveStatus");
  if (workoutSaveStatus) workoutSaveStatus.textContent = "Workout log saved/updated for today.";
  setButtonBusy("wgerWorkoutSaveBtn", false, "Log Selected Workout");
}

async function saveNutritionViaWger() {
  setButtonBusy("wgerNutritionSaveBtn", true, "Log Selected Nutrition");
  const statusLabel = document.getElementById("nutritionSourceStatus");
  const userInfo = await getUserInfo();
  if (!userInfo) {
    if (statusLabel) statusLabel.textContent = "Login required before saving nutrition.";
    setButtonBusy("wgerNutritionSaveBtn", false, "Log Selected Nutrition");
    showToast("You must be logged in to save nutrition data.", "error");
    return;
  }

  const foodFocus = document.getElementById("wgerFoodFocus")?.value || "";
  const ingredientSelect = document.getElementById("wgerIngredientSelect");
  const grams = Number(document.getElementById("wgerGrams")?.value || 0);
  const mealType = document.getElementById("wgerMealType")?.value || "snacks";
  const hydration = document.getElementById("wgerHydration")?.checked || false;
  const protein = document.getElementById("wgerProtein")?.checked || false;
  const balancedMeal = document.getElementById("wgerBalancedMeal")?.checked || false;

  if (!ingredientSelect?.value || ingredientSelect.value === "") {
    if (statusLabel) statusLabel.textContent = "Select an ingredient result before saving.";
    setButtonBusy("wgerNutritionSaveBtn", false, "Log Selected Nutrition");
    showToast("Please search for and select an ingredient first.", "error");
    return;
  }
  if (grams <= 0) {
    if (statusLabel) statusLabel.textContent = "Amount must be greater than 0 grams.";
    setButtonBusy("wgerNutritionSaveBtn", false, "Log Selected Nutrition");
    showToast("Amount must be greater than 0 grams.", "error");
    return;
  }

  const ingredient = wgerState.ingredients.find(
    (item) => String(item.id) === ingredientSelect.value
  );
  const ingredientName =
    ingredient?.name ||
    ingredientSelect.options[ingredientSelect.selectedIndex]?.text ||
    "Ingredient";
  const entryText = `${ingredientName} (${grams}g)`;

  const meals = { breakfast: "-", lunch: "-", dinner: "-", snacks: "-" };
  meals[mealType] = entryText;

  const notes = [
    `Wger item: ${entryText}`,
    ingredient?.energy != null ? `Energy: ${ingredient.energy} kcal/100g` : null,
    ingredient?.protein != null ? `Protein: ${ingredient.protein}g/100g` : null,
    ...getMealCaptureSummary("wger"),
  ]
    .filter(Boolean);

  const entry_date = new Date().toISOString().split("T")[0];
  const { user_id, username } = userInfo;

  const { error } = await upsertWithFallback(
    "daily_nutrition",
    {
      user_id,
      username,
      entry_date,
      breakfast: meals.breakfast,
      lunch: meals.lunch,
      dinner: meals.dinner,
      snacks: meals.snacks,
      hydration_goal_met: hydration ? "Yes" : "No",
      protein_goal_met: protein ? "Yes" : "No",
      balanced_meal_goal_met: balancedMeal ? "Yes" : "No",
      notes_or_regrets: combineNoteParts(notes),
    },
    "user_id,entry_date"
  );

  if (error) {
    if (statusLabel) statusLabel.textContent = "Nutrition save failed. Check form and try again.";
    setButtonBusy("wgerNutritionSaveBtn", false, "Log Selected Nutrition");
    showToast(handleError(error, "daily_nutrition", user_id, entry_date), "error");
    return;
  }

  const proteinPct = protein ? 82 : 48;
  const caloriePct = balancedMeal ? 65 : 40;
  const recoveryPct = hydration ? 78 : 52;
  animateMeterById("proteinMeter", proteinPct);
  animateMeterById("calorieMeter", caloriePct);
  animateMeterById("recoveryMeter", recoveryPct);
  const proteinText = document.getElementById("proteinPct");
  const calorieText = document.getElementById("caloriePct");
  const recoveryText = document.getElementById("recoveryPct");
  if (proteinText) proteinText.textContent = `${proteinPct}%`;
  if (calorieText) calorieText.textContent = `${caloriePct}%`;
  if (recoveryText) recoveryText.textContent = `${recoveryPct}%`;
  showXpPop("+15 XP");
  maybeNotify("Nutrition saved", `${ingredientName} logged through Wger.`);
  showToast("Nutrition data saved successfully via Wger!", "success");
  addXp(15);
  markMissionComplete("log_nutrition");
  if (statusLabel) statusLabel.textContent = "Nutrition saved to your daily log.";
  const nutritionSaveStatus = document.getElementById("nutritionSaveStatus");
  if (nutritionSaveStatus) nutritionSaveStatus.textContent = "Nutrition log saved/updated for today.";
  setButtonBusy("wgerNutritionSaveBtn", false, "Log Selected Nutrition");
}

function setupWgerPrimaryLoggers() {
  document
    .getElementById("wgerWorkoutSaveBtn")
    ?.addEventListener("click", saveWorkoutViaWger);
  document
    .getElementById("wgerNutritionSaveBtn")
    ?.addEventListener("click", saveNutritionViaWger);
}

// â”€â”€â”€ ALL OTHER UNCHANGED LOGIC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getValues() {
  const userInfo = await getUserInfo();
  if (!userInfo) {
    const workoutSaveStatus = document.getElementById("workoutSaveStatus");
    if (workoutSaveStatus) workoutSaveStatus.textContent = "Please login to save workout data.";
    showToast("You must be logged in to save workouts. Please log in first.", "error");
    return;
  }
  const { user_id, username } = userInfo;
  const intensityRaw = document.getElementById("workout-intensity")?.value;
  const mg1Raw = document.getElementById("muscle-group")?.value;
  const mg2Raw = document.getElementById("muscle-group2")?.value;
  const workout_intensity = intensityRaw
    ? intensityRaw[0].toUpperCase() + intensityRaw.slice(1).toLowerCase()
    : null;
  const muscleMap = {
    chest: "Chest", back: "Back", legs: "Leg", leg: "Leg",
    bicep: "Bicep", tricep: "Tricep", shoulders: "Shoulder", shoulder: "Shoulder",
  };
  const mg1 = mg1Raw ? muscleMap[mg1Raw] ?? null : null;
  const mg2 = mg2Raw ? muscleMap[mg2Raw] ?? null : null;
  const muscle_groups = [mg1, mg2].filter(Boolean);
  const date = new Date().toISOString().split("T")[0];

  // Auto-pick an energy_level based on intensity so the DB check constraint
  // is satisfied without showing the field in the UI.
  let energy_level = null;
  if (intensityRaw === "light") energy_level = 4;
  else if (intensityRaw === "intense") energy_level = 2;
  else if (intensityRaw === "moderate") energy_level = 3;

  const { data, error } = await upsertWithFallback(
    "workout_daily",
    { user_id, username, date, workout_status: "Workout done", workout_intensity, muscle_groups, energy_level },
    "user_id,date"
  );

  if (error) {
    showToast(handleError(error, "workout_daily", user_id, date), "error");
  } else {
    uiState.sessionXp += 30;
    animateNumber("sessionXp", uiState.sessionXp);
    animateMeterById("sessionXpMeter", Math.min(100, uiState.sessionXp));
    showXpPop("+30 XP");
    maybeNotify("Workout saved", "Mission progress increased.");
    showToast("Workout saved successfully!", "success");
    addXp(30);
    markMissionComplete("log_workout");
    const workoutSaveStatus = document.getElementById("workoutSaveStatus");
    if (workoutSaveStatus) workoutSaveStatus.textContent = "Workout log saved/updated for today.";
  }
}

async function loadTodaySleepEntry() {
  const userInfo = await getUserInfo();
  const statusEl = document.getElementById("sleepStatus");
  if (!userInfo) {
    if (statusEl) statusEl.textContent = "Please login to load or save sleep data.";
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const { data, error } = await supabase
    .from("daily_sleep")
    .select('"Date", hours_slept, sleep_emoji')
    .eq("user_id", userInfo.user_id)
    .eq("Date", today)
    .maybeSingle();
  if (error || !data) {
    if (statusEl) statusEl.textContent = "No sleep log yet today. Save to create one.";
    return;
  }

  const emojiToSelect = {
    "\u{1F634}\u{1F6CC}\u{1F4A4}": "emoji1",
    "\u{1F603}\u{2600}\u{FE0F}\u{1F31E}": "emoji2",
    "\u{1F62C}\u{2615}\u{1F971}": "emoji3",
    "\u{1F621}\u{23F0}\u{1F612}": "emoji4",
    "\u{1F3C3}\u{200D}\u{2642}\u{FE0F}\u{1F4A8}\u{23F1}\u{FE0F}": "emoji5",
  };
  const sleepInput = document.getElementById("sleepInput");
  const emojiSelect = document.getElementById("emojiSelect");
  if (sleepInput) sleepInput.value = String(data.hours_slept ?? "");
  if (emojiSelect && data.sleep_emoji && emojiToSelect[data.sleep_emoji]) {
    emojiSelect.value = emojiToSelect[data.sleep_emoji];
  }
  if (statusEl) statusEl.textContent = "Today's sleep log loaded. Edit and save to update.";
}

async function saveSleepData() {
  const userInfo = await getUserInfo();
  const statusEl = document.getElementById("sleepStatus");
  if (!userInfo) {
    if (statusEl) statusEl.textContent = "Please login to save sleep data.";
    showToast("You must be logged in to save sleep data.", "error");
    return;
  }
  const { user_id, username } = userInfo;
  const hoursSleptRaw = document.getElementById("sleepInput")?.value;
  const emojiRaw = document.getElementById("emojiSelect")?.value;
  if (!hoursSleptRaw || !emojiRaw) {
    if (statusEl) statusEl.textContent = "Please fill in all sleep fields.";
    showToast("Please fill in all sleep fields.", "error");
    return;
  }
  const hours_slept = parseFloat(hoursSleptRaw);
  const date = new Date().toISOString().split("T")[0];
  const emojiMap = {
    emoji1: "\u{1F634}\u{1F6CC}\u{1F4A4}",
    emoji2: "\u{1F603}\u{2600}\u{FE0F}\u{1F31E}",
    emoji3: "\u{1F62C}\u{2615}\u{1F971}",
    emoji4: "\u{1F621}\u{23F0}\u{1F612}",
    emoji5: "\u{1F3C3}\u{200D}\u{2642}\u{FE0F}\u{1F4A8}\u{23F1}\u{FE0F}",
  };
  const sleep_emoji = emojiMap[emojiRaw] || emojiRaw;
  if (hours_slept < 0 || hours_slept > 12) {
    if (statusEl) statusEl.textContent = "Hours slept must be between 0 and 12.";
    showToast(`Hours slept must be between 0 and 12.`, "error");
    return;
  }
  const validEmojis = Object.values(emojiMap);
  if (!validEmojis.includes(sleep_emoji)) { showToast("Invalid sleep emoji.", "error"); return; }
  const { data, error } = await upsertWithFallback(
    "daily_sleep",
    { user_id, username, Date: date, hours_slept, sleep_emoji },
    'user_id,"Date"'
  );
  if (error) {
    if (statusEl) statusEl.textContent = "Sleep save failed. Try again.";
    showToast(handleError(error, "daily_sleep", user_id, date), "error");
  }
  else {
    showXpPop("+10 XP");
    const sleepPct = Math.min(100, Math.round((hours_slept / 10) * 100));
    const morningPct = Math.min(100, Math.round((hours_slept / 9) * 100));
    const stressPct = Math.max(0, 100 - Math.round((hours_slept / 10) * 70));
    animateMeterById("sleepMeter", sleepPct);
    animateMeterById("morningMeter", morningPct);
    animateMeterById("stressMeter", stressPct);
    const sleepBankLabel = document.getElementById("sleepBankLabel");
    const morningLabel = document.getElementById("morningLabel");
    const stressLabel = document.getElementById("stressLabel");
    if (sleepBankLabel) sleepBankLabel.textContent = `${sleepPct}%`;
    if (morningLabel) morningLabel.textContent = `${morningPct}%`;
    if (stressLabel) stressLabel.textContent = `${stressPct}%`;
    maybeNotify("Sleep log saved", `Recovery updated: ${hours_slept}h`);
    showToast("Sleep data saved successfully!", "success");
    addXp(10, "sleep_log");
    markMissionComplete("log_sleep");
    if (statusEl) statusEl.textContent = "Sleep log saved/updated for today.";
  }
}

async function saveNutritionData() {
  const userInfo = await getUserInfo();
  const nutritionSaveStatus = document.getElementById("nutritionSaveStatus");
  if (!userInfo) {
    if (nutritionSaveStatus) nutritionSaveStatus.textContent = "Please login to save nutrition data.";
    showToast("You must be logged in to save nutrition data.", "error");
    return;
  }
  const { user_id, username } = userInfo;
  const breakfast = document.getElementById("breakfast")?.value?.trim() || "";
  const lunch = document.getElementById("lunch")?.value?.trim() || "";
  const dinner = document.getElementById("dinner")?.value?.trim() || "";
  const snacks = document.getElementById("snacks")?.value?.trim() || "";
  const hydration = document.getElementById("hydration")?.checked || false;
  const protein = document.getElementById("protein")?.checked || false;
  const balancedMeal = document.getElementById("balanced_meal")?.checked || false;
  const notes = document.getElementById("notes")?.value?.trim() || null;
  if (!breakfast || !lunch || !dinner || !snacks) { showToast("Please fill in all meal fields.", "error"); return; }
  const entry_date = new Date().toISOString().split("T")[0];
  const noteParts = [notes, ...getMealCaptureSummary("manual")];
  const { data, error } = await upsertWithFallback(
    "daily_nutrition",
    {
      user_id, username, entry_date, breakfast, lunch, dinner, snacks,
      hydration_goal_met: hydration ? "Yes" : "No",
      protein_goal_met: protein ? "Yes" : "No",
      balanced_meal_goal_met: balancedMeal ? "Yes" : "No",
      notes_or_regrets: combineNoteParts(noteParts),
    },
    "user_id,entry_date"
  );
  if (error) { showToast(handleError(error, "daily_nutrition", user_id, entry_date), "error"); }
  else {
    const proteinPct = protein ? 82 : 48;
    const caloriePct = balancedMeal ? 65 : 40;
    const recoveryPct = hydration ? 78 : 52;
    animateMeterById("proteinMeter", proteinPct);
    animateMeterById("calorieMeter", caloriePct);
    animateMeterById("recoveryMeter", recoveryPct);
    document.getElementById("proteinPct")?.textContent && (document.getElementById("proteinPct").textContent = `${proteinPct}%`);
    document.getElementById("caloriePct")?.textContent && (document.getElementById("caloriePct").textContent = `${caloriePct}%`);
    document.getElementById("recoveryPct")?.textContent && (document.getElementById("recoveryPct").textContent = `${recoveryPct}%`);
    showXpPop("+15 XP");
    maybeNotify("Nutrition saved", "Fuel goals updated.");
    showToast("Nutrition data saved successfully!", "success");
    addXp(15, "nutrition_log");
    markMissionComplete("log_nutrition");
    if (nutritionSaveStatus) nutritionSaveStatus.textContent = "Nutrition log saved/updated for today.";
  }
}

window.getValues = getValues;
window.saveSleepData = saveSleepData;
window.saveNutritionData = saveNutritionData;

// â”€â”€â”€ WORKOUT CHALLENGES & LEADERBOARD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function submitChallenge() {
  const userInfo = await getUserInfo();
  if (!userInfo) {
    showToast("You must be logged in to post a challenge.", "error");
    return;
  }
  const { user_id, username } = userInfo;

  const nameInput = document.getElementById("challengeExercise");
  const repsInput = document.getElementById("challengeReps");
  const weightInput = document.getElementById("challengeWeight");
  const statusEl = document.getElementById("challengeStatus");

  const exercise_name = nameInput?.value.trim() || "";
  const reps = Number(repsInput?.value || 0);
  const weight = Number(weightInput?.value || 0);

  if (!exercise_name) {
    showToast("Please enter an exercise name for the challenge.", "error");
    return;
  }
  if (reps <= 0 || weight <= 0) {
    showToast("Reps and weight must be greater than 0.", "error");
    return;
  }

  const score = reps * weight;

  if (statusEl) statusEl.textContent = "Saving challenge...";

  const { error } = await supabase.from("workout_challenges").insert({
    user_id,
    username,
    exercise_name,
    reps,
    weight,
    score,
  });

  if (error) {
    console.error("Challenge save failed:", error);
    if (statusEl) statusEl.textContent = "Could not save challenge. Please try again.";
    showToast("Challenge save failed: " + error.message, "error");
    return;
  }

  if (statusEl) {
    statusEl.textContent = `Saved: ${exercise_name} - ${reps} reps x ${weight} kg (Score ${score}).`;
  }
  showXpPop("+25 XP (Challenge)");
  addXp(25);
  markMissionComplete("post_challenge");
}

async function loadLeaderboard() {
  const list = document.getElementById("leaderboardList");
  if (!list) return;

  list.replaceChildren();
  const userInfo = await getUserInfo();
  if (!userInfo) {
    const li = document.createElement("li");
    li.textContent = "Please login to view leaderboard data.";
    list.appendChild(li);
    showLoginRequiredMessage("rivalLabel");
    showLoginRequiredMessage("statusRankLabel");
    return;
  }

  const { data, error } = await supabase
    .from("workout_challenges")
    .select("user_id, username, exercise_name, score")
    .order("score", { ascending: false })
    .limit(100);

  if (error) {
    console.error("Leaderboard load failed:", error);
    const li = document.createElement("li");
    li.textContent = "Could not load leaderboard.";
    list.appendChild(li);
    return;
  }

  const aggregated = new Map();
  data.forEach((row) => {
    const key = row.user_id;
    const current = aggregated.get(key) || {
      user_id: row.user_id,
      username: row.username,
      bestScore: 0,
      bestExercise: "",
    };
    if (row.score > current.bestScore) {
      current.bestScore = row.score;
      current.bestExercise = row.exercise_name;
    }
    aggregated.set(key, current);
  });

  const rows = Array.from(aggregated.values()).sort(
    (a, b) => b.bestScore - a.bestScore
  );
  if (!rows.length) {
    const li = document.createElement("li");
    li.textContent = "No leaderboard data yet. Post the first challenge.";
    list.appendChild(li);
    showLoginRequiredMessage("rivalLabel", "No rivals yet. Be the first to post a challenge.");
    showLoginRequiredMessage("statusRankLabel", "Not ranked");
    return;
  }

  const myId = userInfo?.user_id;
  let myRank = null;
  let rival = null;

  rows.slice(0, 20).forEach((row, index) => {
    const li = document.createElement("li");
    const left = document.createElement("span");
    const right = document.createElement("strong");

    left.textContent = `${index + 1}. ${row.username} - ${row.bestExercise}`;
    right.textContent = `Score ${row.bestScore}`;

    li.append(left, right);
    list.appendChild(li);

    if (row.user_id === myId) {
      myRank = index + 1;
      rival = rows[index - 1] || null;
    }
  });

  const rankLabel = document.getElementById("statusRankLabel");
  if (rankLabel) {
    rankLabel.textContent = myRank ? `#${myRank}` : "Not ranked yet";
  }
  const rivalLabel = document.getElementById("rivalLabel");
  if (rivalLabel) {
    rivalLabel.textContent = rival
      ? `Closest rival above you: ${rival.username} (${rival.bestScore})`
      : myRank
        ? "You are currently at the top. Keep defending your spot."
        : "Post a challenge to get ranked and unlock rivals.";
  }
  const rankChangeLabel = document.getElementById("statusRankChangeLabel");
  if (rankChangeLabel) {
    const prev = gamificationState.leaderboardLastRank;
    if (!myRank || !prev) {
      rankChangeLabel.textContent = myRank ? "new this session" : "-";
    } else {
      const diff = prev - myRank;
      if (diff > 0) rankChangeLabel.textContent = `up ${diff}`;
      else if (diff < 0) rankChangeLabel.textContent = `down ${Math.abs(diff)}`;
      else rankChangeLabel.textContent = "no change";
    }
  }
  gamificationState.leaderboardLastRank = myRank;
}

function setupChallengeSection() {
  document
    .getElementById("challengeSubmitBtn")
    ?.addEventListener("click", submitChallenge);
}

function setupWorkoutShortcuts() {
  const workoutPage = document.getElementById("workout");
  if (!workoutPage) return;
  const setCounter = document.getElementById("setCounter");
  const addSetBtn = document.getElementById("addSetBtn");
  const repeatWorkoutBtn = document.getElementById("repeatWorkoutBtn");
  const setsInput = document.getElementById("wgerSets");
  const intensity = document.getElementById("wgerWorkoutIntensity");
  const muscleFocus = document.getElementById("wgerMuscleFocus");
  const exerciseSearch = document.getElementById("wgerExerciseSearch");

  const addSet = () => {
    addWorkoutSetDraft();
    uiState.setCount += 1;
    uiState.sessionXp += 20;
    if (setCounter) setCounter.textContent = `Sets logged: ${uiState.setCount}`;
    if (setsInput) setsInput.value = String(workoutPlannerState.workoutSets.length);
    animateNumber("sessionXp", uiState.sessionXp);
    animateMeterById("sessionXpMeter", Math.min(100, uiState.sessionXp));
    showXpPop("+20 XP");
  };

  addSetBtn?.addEventListener("click", addSet);
  repeatWorkoutBtn?.addEventListener("click", () => {
    const cached = localStorage.getItem("lastWorkoutPreset");
    if (!cached) return;
    try {
      const value = JSON.parse(cached);
      if (intensity && value.intensity) intensity.value = value.intensity;
      if (muscleFocus && value.muscleFocus) muscleFocus.value = value.muscleFocus;
      if (exerciseSearch && value.exerciseSearch) exerciseSearch.value = value.exerciseSearch;
      if (Array.isArray(value.workoutSets) && value.workoutSets.length) {
        workoutPlannerState.workoutSets = value.workoutSets.map((entry) => ({
          id: `set_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          reps: String(entry.reps || "8"),
          weight: String(entry.weight || "0"),
        }));
        renderWorkoutSetRows();
        if (setsInput) setsInput.value = String(workoutPlannerState.workoutSets.length);
      }
      showXpPop("Preset loaded");
    } catch { /* ignore */ }
  });
  document.addEventListener("keydown", (event) => {
    const activeTag = document.activeElement?.tagName;
    const typing = activeTag === "INPUT" || activeTag === "TEXTAREA";
    if (event.code === "Space" && !typing) { event.preventDefault(); addSet(); }
    if (event.key === "Enter" && !typing) { event.preventDefault(); workoutPage.click(); }
    if ((event.key === "r" || event.key === "R") && !typing) { event.preventDefault(); repeatWorkoutBtn?.click(); }
  });
  workoutPage.addEventListener("click", () => {
    const payload = {
      intensity: intensity?.value,
      muscleFocus: muscleFocus?.value,
      exerciseSearch: exerciseSearch?.value,
      workoutSets: workoutPlannerState.workoutSets,
    };
    localStorage.setItem("lastWorkoutPreset", JSON.stringify(payload));
  });
}

function setupShareActions() {
  document.getElementById("copyShareBtn")?.addEventListener("click", async () => {
    const text = "NEW PR: Deadlift 140kg. Level Up -> 15";
    try { await navigator.clipboard.writeText(text); showXpPop("Copied"); }
    catch { showToast("Failed to copy. " + text, "error"); }
  });
  document.getElementById("downloadShareBtn")?.addEventListener("click", () => {
    const blob = new Blob(["NEW PR\nDeadlift 140kg\nLevel Up -> 15"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "zynergy-pr-card.txt"; a.click();
    URL.revokeObjectURL(url);
    document.getElementById("shareCard")?.classList.add("shake");
    setTimeout(() => document.getElementById("shareCard")?.classList.remove("shake"), 700);
  });
  document.getElementById("shareWhatsAppBtn")?.addEventListener("click", () => {
    window.open(`https://wa.me/?text=${encodeURIComponent("NEW PR! Deadlift 140kg. Level Up to 15.")}`, "_blank");
  });
}

function setupNotifications() {
  document.getElementById("notifyEnableBtn")?.addEventListener("click", async () => {
    if (!("Notification" in window)) return;
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      showXpPop("Alerts on");
      maybeNotify("ZYNERGY alerts enabled", "You will receive streak reminders.");
    }
  });
}

function setupThemeToggle() {
  const themeBtn = document.getElementById("themeToggleBtn");
  const rawTheme = localStorage.getItem("zynergyTheme") || "default";
  const savedTheme = rawTheme === "ion" ? "ion" : "default";
  applyTheme(savedTheme);
  if (!themeBtn) return;
  const labelMap = { default: "Theme: Black", ion: "Theme: Blue" };
  themeBtn.textContent = labelMap[savedTheme] || labelMap.default;
  themeBtn.addEventListener("click", () => {
    const current = document.body.getAttribute("data-theme") || "default";
    const next = current === "default" ? "ion" : "default";
    localStorage.setItem("zynergyTheme", next);
    applyTheme(next);
    themeBtn.textContent = labelMap[next] || labelMap.default;
    showXpPop("Theme switched");
  });
}

function setupMissionBoard() {
  if (!document.getElementById("missionList")) return;
  gamificationState.dailyMissions = getDailyMissionCatalog();
  gamificationState.completedMissionKeys = loadMissionProgress();
  renderMissionBoard();
}

function buildBadgeCatalog() {
  return [
    { key: "badge_streak_3", label: "Streak Rookie", test: (ctx) => ctx.streak >= 3 },
    { key: "badge_streak_7", label: "Consistency Core", test: (ctx) => ctx.streak >= 7 },
    { key: "badge_week_full", label: "Seven Day Sprint", test: (ctx) => ctx.weeklyLogs >= 7 },
    { key: "badge_challenge_3", label: "Platform Competitor", test: (ctx) => ctx.challengeCount >= 3 },
  ];
}

function renderBadges(unlockedKeys) {
  const list = document.getElementById("badgeList");
  if (!list) return;
  list.replaceChildren();
  const badgeCatalog = buildBadgeCatalog();
  badgeCatalog.forEach((badge) => {
    const li = document.createElement("li");
    li.classList.toggle("done", unlockedKeys.has(badge.key));
    const label = document.createElement("span");
    label.textContent = badge.label;
    const state = document.createElement("span");
    state.className = "pill";
    state.textContent = unlockedKeys.has(badge.key) ? "Unlocked" : "Locked";
    li.append(label, state);
    list.appendChild(li);
  });
}

async function loadGamificationBadgesAndQuest() {
  const userInfo = await getUserInfo();
  if (!userInfo) return;
  const { user_id } = userInfo;
  const weekStart = daysAgoLocal(6);
  const today = toLocalDateString(new Date());

  const [{ data: workouts }, { data: nutrition }, { data: sleep }, { data: challenges }] =
    await Promise.all([
      supabase.from("workout_daily").select("date").eq("user_id", user_id).gte("date", weekStart).lte("date", today),
      supabase.from("daily_nutrition").select("entry_date").eq("user_id", user_id).gte("entry_date", weekStart).lte("entry_date", today),
      supabase.from("daily_sleep").select('"Date"').eq("user_id", user_id).gte("Date", weekStart).lte("Date", today),
      supabase.from("workout_challenges").select("user_id").eq("user_id", user_id).limit(200),
    ]);

  const dailyDates = [
    ...(workouts || []).map((x) => x.date),
    ...(nutrition || []).map((x) => x.entry_date),
    ...(sleep || []).map((x) => x.Date),
  ];
  const streak = computeDailyStreak(dailyDates);
  const weeklyLogs =
    (workouts || []).length + (nutrition || []).length + (sleep || []).length;
  const challengeCount = (challenges || []).length;

  const context = { streak, weeklyLogs, challengeCount };
  const unlocked = new Set(
    buildBadgeCatalog()
      .filter((badge) => badge.test(context))
      .map((badge) => badge.key)
  );
  gamificationState.badges = Array.from(unlocked);
  renderBadges(unlocked);

  const weeklyTarget = 10;
  const weeklyQuestDone = Math.min(weeklyTarget, weeklyLogs);
  const weeklyPct = Math.round((weeklyQuestDone / weeklyTarget) * 100);
  const weeklyQuestLabel = document.getElementById("weeklyQuestLabel");
  const weeklyQuestPct = document.getElementById("weeklyQuestPct");
  if (weeklyQuestLabel) {
    weeklyQuestLabel.textContent = `Complete ${weeklyTarget} combined logs this week (${weeklyQuestDone}/${weeklyTarget}). Reward: +50 XP.`;
  }
  if (weeklyQuestPct) weeklyQuestPct.textContent = `${weeklyPct}%`;
  animateMeterById("weeklyQuestMeter", weeklyPct);
}

function toLocalDateString(date) {
  return date.toISOString().split("T")[0];
}

function daysAgoLocal(days) {
  const now = new Date();
  now.setDate(now.getDate() - days);
  return toLocalDateString(now);
}

function setButtonBusy(buttonId, isBusy, idleLabel = "Save") {
  const button = document.getElementById(buttonId);
  if (!button) return;
  if (isBusy) {
    button.dataset.previousLabel = button.textContent || idleLabel;
    button.textContent = "Saving...";
    button.disabled = true;
    return;
  }
  button.disabled = false;
  button.textContent = button.dataset.previousLabel || idleLabel;
}

function computeDailyStreak(dates) {
  const unique = new Set((dates || []).filter(Boolean));
  if (!unique.size) return 0;
  let streak = 0;
  const cursor = new Date();
  while (true) {
    const key = toLocalDateString(cursor);
    if (!unique.has(key)) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

async function loadSidebarProfileStats() {
  const userInfo = await getUserInfo();
  if (!userInfo) {
    showLoginRequiredMessage("workoutLevelLabel");
    showLoginRequiredMessage("workoutStreakLabel");
    showLoginRequiredMessage("dashboardLevelLabel");
    showLoginRequiredMessage("dashboardRankLabel");
    showLoginRequiredMessage("dashboardStreakLabel");
    showLoginRequiredMessage("dashboardProteinAvgLabel");
    showLoginRequiredMessage("nutritionAvgLabel");
    showLoginRequiredMessage("nutritionXpLabel");
    showLoginRequiredMessage("statusXpLabel");
    showLoginRequiredMessage("dashboardHeaderSubtitle", "Please login to view your live progress.");
    return;
  }

  const { user_id } = userInfo;
  const streakSources = [];
  const today = toLocalDateString(new Date());

  const { data: workouts } = await supabase
    .from("workout_daily")
    .select("date")
    .eq("user_id", user_id)
    .gte("date", daysAgoLocal(45))
    .lte("date", today);
  streakSources.push(...(workouts || []).map((row) => row.date));

  const { data: sleep } = await supabase
    .from("daily_sleep")
    .select('"Date"')
    .eq("user_id", user_id)
    .gte("Date", daysAgoLocal(45))
    .lte("Date", today);
  streakSources.push(...(sleep || []).map((row) => row.Date));

  const { data: nutrition } = await supabase
    .from("daily_nutrition")
    .select("entry_date")
    .eq("user_id", user_id)
    .gte("entry_date", daysAgoLocal(45))
    .lte("entry_date", today);
  streakSources.push(...(nutrition || []).map((row) => row.entry_date));

  const streak = computeDailyStreak(streakSources);
  const streakLabel = document.getElementById("workoutStreakLabel");
  if (streakLabel) streakLabel.textContent = streak > 0 ? `${streak} day(s)` : "Start today";

  const { data: profile } = await supabase
    .from("user_profile")
    .select("xp")
    .eq("user_id", user_id)
    .maybeSingle();
  const xp = Number(profile?.xp || 0);
  const level = getLevelFromXp(xp);
  const levelLabel = document.getElementById("workoutLevelLabel");
  if (levelLabel) levelLabel.textContent = `${level.level} - ${level.name}`;
  const statusXpLabel = document.getElementById("statusXpLabel");
  if (statusXpLabel) statusXpLabel.textContent = String(xp);
  const xpValue = document.getElementById("xpValue");
  if (xpValue) xpValue.textContent = String(xp);
  const xpPct = Math.min(100, Math.round((xp % 1000) / 10));
  animateMeterById("xpMeter", xpPct);
  const xpMetaLabel = document.getElementById("xpMetaLabel");
  if (xpMetaLabel) xpMetaLabel.textContent = `${xpPct}% to next milestone`;

  const dashboardLevel = document.getElementById("dashboardLevelLabel");
  const dashboardStreak = document.getElementById("dashboardStreakLabel");
  const dashboardRank = document.getElementById("dashboardRankLabel");
  const headerTitle = document.getElementById("dashboardHeaderTitle");
  const headerSubtitle = document.getElementById("dashboardHeaderSubtitle");
  if (dashboardLevel) dashboardLevel.textContent = `${level.level} - ${level.name}`;
  if (dashboardStreak) dashboardStreak.textContent = streak > 0 ? `${streak} day(s)` : "Start today";
  if (dashboardRank) dashboardRank.textContent = "Syncing...";
  if (headerTitle) headerTitle.textContent = `Level ${level.level} - ${level.name}`;
  if (headerSubtitle) headerSubtitle.textContent = "Open, log, earn XP, and keep your streak alive.";

  const { data: rankRows } = await supabase
    .from("workout_challenges")
    .select("user_id, score")
    .order("score", { ascending: false })
    .limit(200);
  if (Array.isArray(rankRows) && rankRows.length) {
    const bestByUser = new Map();
    rankRows.forEach((row) => {
      const current = bestByUser.get(row.user_id) || 0;
      if (row.score > current) bestByUser.set(row.user_id, row.score);
    });
    const sortedIds = Array.from(bestByUser.entries()).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
    const rankIndex = sortedIds.findIndex((id) => id === user_id);
    if (dashboardRank) dashboardRank.textContent = rankIndex >= 0 ? `#${rankIndex + 1}` : "Not ranked";
  } else if (dashboardRank) {
    dashboardRank.textContent = "No data";
  }

  const proteinAvgLabel = document.getElementById("dashboardProteinAvgLabel");
  const nutritionAvgLabel = document.getElementById("nutritionAvgLabel");
  const nutritionXpLabel = document.getElementById("nutritionXpLabel");
  const { data: recentNutrition } = await supabase
    .from("daily_nutrition")
    .select("protein_goal_met")
    .eq("user_id", user_id)
    .gte("entry_date", daysAgoLocal(14))
    .order("entry_date", { ascending: false });
  if (Array.isArray(recentNutrition) && recentNutrition.length) {
    const metCount = recentNutrition.filter((row) => row.protein_goal_met === "Yes").length;
    const pct = Math.round((metCount / recentNutrition.length) * 100);
    const label = `${pct}% goal hits`;
    if (proteinAvgLabel) proteinAvgLabel.textContent = label;
    if (nutritionAvgLabel) nutritionAvgLabel.textContent = label;
  } else {
    if (proteinAvgLabel) proteinAvgLabel.textContent = "No data";
    if (nutritionAvgLabel) nutritionAvgLabel.textContent = "No data";
  }
  if (nutritionXpLabel) nutritionXpLabel.textContent = String(xp);
}

async function loadWeeklySummary() {
  const userInfo = await getUserInfo();
  if (!userInfo) {
    showLoginRequiredMessage("weeklyWorkoutLabel");
    showLoginRequiredMessage("weeklyNutritionLabel");
    showLoginRequiredMessage("weeklySleepLabel");
    return;
  }
  const { user_id } = userInfo;
  const weekStart = daysAgoLocal(6);
  const today = toLocalDateString(new Date());

  const [{ data: workouts }, { data: nutrition }, { data: sleep }] = await Promise.all([
    supabase.from("workout_daily").select("date").eq("user_id", user_id).gte("date", weekStart).lte("date", today),
    supabase.from("daily_nutrition").select("entry_date").eq("user_id", user_id).gte("entry_date", weekStart).lte("entry_date", today),
    supabase.from("daily_sleep").select('"Date", hours_slept').eq("user_id", user_id).gte("Date", weekStart).lte("Date", today),
  ]);

  const workoutPct = Math.min(100, Math.round(((workouts || []).length / 7) * 100));
  const nutritionPct = Math.min(100, Math.round(((nutrition || []).length / 7) * 100));
  const sleepPct = Math.min(100, Math.round(((sleep || []).length / 7) * 100));

  animateMeterById("weeklyWorkoutMeter", workoutPct);
  animateMeterById("weeklyNutritionMeter", nutritionPct);
  animateMeterById("weeklySleepMeter", sleepPct);
  const wk = document.getElementById("weeklyWorkoutLabel");
  const nt = document.getElementById("weeklyNutritionLabel");
  const sl = document.getElementById("weeklySleepLabel");
  if (wk) wk.textContent = `${workoutPct}%`;
  if (nt) nt.textContent = `${nutritionPct}%`;
  if (sl) sl.textContent = `${sleepPct}%`;
  const dashboardSleepQualityLabel = document.getElementById("dashboardSleepQualityLabel");
  const dashboardHydrationLabel = document.getElementById("dashboardHydrationLabel");
  if (dashboardSleepQualityLabel) dashboardSleepQualityLabel.textContent = `${sleepPct}%`;
  if (dashboardHydrationLabel) dashboardHydrationLabel.textContent = `${nutritionPct}%`;
  animateMeterById("dashboardSleepQualityMeter", sleepPct);
  animateMeterById("dashboardHydrationMeter", nutritionPct);

  const sleepRecoveryTier = document.getElementById("sleepRecoveryTierLabel");
  const sleepAvgLabel = document.getElementById("sleepAvgLabel");
  const sleepLateNights = document.getElementById("sleepLateNightsLabel");
  if (sleepRecoveryTier) {
    const tier = sleepPct >= 80 ? "A" : sleepPct >= 60 ? "B" : sleepPct >= 40 ? "C" : "D";
    sleepRecoveryTier.textContent = tier;
  }
  if (sleepAvgLabel) {
    if ((sleep || []).length) {
      const avg = (sleep || []).reduce((sum, row) => sum + Number(row.hours_slept || 0), 0) / (sleep || []).length;
      sleepAvgLabel.textContent = `${avg.toFixed(1)} hrs`;
    } else {
      sleepAvgLabel.textContent = "No data";
    }
  }
  if (sleepLateNights) {
    const lowSleep = (sleep || []).filter((row) => Number(row.hours_slept || 0) < 6).length;
    sleepLateNights.textContent = `${lowSleep} this week`;
  }
}

async function fetchHistoryRows(startDate, endDate, type = "all") {
  const userInfo = await getUserInfo();
  if (!userInfo) return [];
  const { user_id } = userInfo;
  const rows = [];

  if (type === "all" || type === "workout") {
    const { data } = await supabase
      .from("workout_daily")
      .select("date, workout_status, workout_intensity")
      .eq("user_id", user_id)
      .gte("date", startDate)
      .lte("date", endDate)
      .order("date", { ascending: false });
    (data || []).forEach((row) => rows.push({ date: row.date, type: "workout", detail: `${row.workout_status} (${row.workout_intensity || "N/A"})` }));
  }

  if (type === "all" || type === "nutrition") {
    const { data } = await supabase
      .from("daily_nutrition")
      .select("entry_date, breakfast, lunch, dinner, snacks")
      .eq("user_id", user_id)
      .gte("entry_date", startDate)
      .lte("entry_date", endDate)
      .order("entry_date", { ascending: false });
    (data || []).forEach((row) => rows.push({ date: row.entry_date, type: "nutrition", detail: [row.breakfast, row.lunch, row.dinner, row.snacks].filter(Boolean).join(" | ") }));
  }

  if (type === "all" || type === "sleep") {
    const { data } = await supabase
      .from("daily_sleep")
      .select('"Date", hours_slept, sleep_emoji')
      .eq("user_id", user_id)
      .gte("Date", startDate)
      .lte("Date", endDate)
      .order("Date", { ascending: false });
    (data || []).forEach((row) => rows.push({ date: row.Date, type: "sleep", detail: `${row.hours_slept}h ${row.sleep_emoji || ""}`.trim() }));
  }

  return rows.sort((a, b) => (a.date < b.date ? 1 : -1));
}

function downloadTextFile(filename, content, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function historyRowsToCsv(rows) {
  const header = "date,type,detail";
  const lines = rows.map((row) => {
    const safeDetail = `"${String(row.detail || "").replace(/"/g, '""')}"`;
    return `${row.date},${row.type},${safeDetail}`;
  });
  return [header, ...lines].join("\n");
}

function setupHistoryPage() {
  const applyBtn = document.getElementById("historyApplyBtn");
  if (!applyBtn) return;
  const startInput = document.getElementById("historyStartDate");
  const endInput = document.getElementById("historyEndDate");
  const typeInput = document.getElementById("historyType");
  const status = document.getElementById("historyStatus");
  const list = document.getElementById("historyList");
  const exportJsonBtn = document.getElementById("historyExportJsonBtn");
  const exportCsvBtn = document.getElementById("historyExportCsvBtn");
  let currentRows = [];

  const initEnd = toLocalDateString(new Date());
  const initStart = daysAgoLocal(7);
  if (startInput && !startInput.value) startInput.value = initStart;
  if (endInput && !endInput.value) endInput.value = initEnd;

  const renderRows = (rows) => {
    if (!list) return;
    list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No entries in this range.";
      list.appendChild(empty);
      return;
    }
    rows.forEach((row) => {
      const item = document.createElement("div");
      item.className = "api-item";
      const title = document.createElement("h3");
      title.textContent = `${row.date} - ${row.type}`;
      const detail = document.createElement("p");
      detail.textContent = row.detail || "-";
      item.append(title, detail);
      list.appendChild(item);
    });
  };

  const run = async () => {
    const userInfo = await getUserInfo();
    if (!userInfo) {
      if (status) status.textContent = "Please login to view history and export data.";
      if (list) list.replaceChildren();
      return;
    }
    const startDate = startInput?.value || initStart;
    const endDate = endInput?.value || initEnd;
    const type = typeInput?.value || "all";
    if (startDate > endDate) {
      if (status) status.textContent = "Start date must be before end date.";
      return;
    }
    if (status) status.textContent = "Loading history...";
    setButtonBusy("historyApplyBtn", true, "Apply Filters");
    currentRows = await fetchHistoryRows(startDate, endDate, type);
    renderRows(currentRows);
    if (status) status.textContent = `Loaded ${currentRows.length} entries.`;
    setButtonBusy("historyApplyBtn", false, "Apply Filters");
  };

  applyBtn.addEventListener("click", run);
  exportJsonBtn?.addEventListener("click", () => {
    downloadTextFile(`zynergy-history-${toLocalDateString(new Date())}.json`, JSON.stringify(currentRows, null, 2), "application/json");
    showXpPop("JSON exported");
  });
  exportCsvBtn?.addEventListener("click", () => {
    downloadTextFile(`zynergy-history-${toLocalDateString(new Date())}.csv`, historyRowsToCsv(currentRows), "text/csv");
    showXpPop("CSV exported");
  });
  run();
}

function setupLeaderboardRefresh() {
  const refreshBtn = document.getElementById("refreshBoardBtn");
  if (!refreshBtn) return;
  refreshBtn.addEventListener("click", () => {
    loadLeaderboard();
    loadWeeklySummary();
    showXpPop("Leaderboard updated");
  });
  loadLeaderboard();
  loadWeeklySummary();
}

function setupManualToggles() {
  document.getElementById("workoutManualToggle")?.addEventListener("click", () => {
    const card = document.getElementById("manualWorkoutCard");
    if (!card) return;
    const showing = !card.classList.contains("hidden");
    card.classList.toggle("hidden", showing);
    document.getElementById("workoutManualToggle").textContent = showing ? "Use Manual Logger" : "Hide Manual Logger";
  });
  document.getElementById("nutritionManualToggle")?.addEventListener("click", () => {
    const card = document.getElementById("manualNutritionCard");
    if (!card) return;
    const showing = !card.classList.contains("hidden");
    card.classList.toggle("hidden", showing);
    document.getElementById("nutritionManualToggle").textContent = showing ? "Use Manual Logger" : "Hide Manual Logger";
  });
}

function setupWorkoutPlanner() {
  if (!document.getElementById("splitPlannerCard")) return;

  renderSplitRows("splitBuilderRows", buildDefaultSplitDays());

  document.getElementById("saveSplitBtn")?.addEventListener("click", createInitialSplit);
  document.getElementById("editSplitBtn")?.addEventListener("click", openSplitEditor);
  document.getElementById("closeSplitEditorBtn")?.addEventListener("click", closeSplitEditor);
  document.getElementById("saveSplitEditBtn")?.addEventListener("click", saveSplitEdit);
  document.getElementById("viewSplitHistoryBtn")?.addEventListener("click", openSplitHistoryDrawer);
  document.getElementById("closeSplitHistoryBtn")?.addEventListener("click", closeSplitHistoryDrawer);
  document.getElementById("refreshPlanBtn")?.addEventListener("click", () => loadWorkoutPlan());
  document.getElementById("splitEditorModal")?.addEventListener("click", (event) => {
    if (event.target?.id === "splitEditorModal") closeSplitEditor();
  });

  loadSplitPlanner();
}

function setupManualWorkoutSection() {
  if (!document.getElementById("manualWorkoutCard")) return;

  document.getElementById("manualTemplateSelect")?.addEventListener("change", (event) => {
    const templateId = event.target?.value;
    if (!templateId) return;
    applyManualTemplate(templateId);
  });

  document.getElementById("manualWorkoutLogBtn")?.addEventListener("click", saveManualWorkoutLog);
  document.getElementById("manualSaveTemplateBtn")?.addEventListener("click", saveManualWorkoutTemplate);

  loadManualTemplates();
}

function setupDailyOverride() {
  if (!document.getElementById("dailyOverrideCard")) return;
  const dateInput = document.getElementById("overrideDateInput");
  if (dateInput && !dateInput.value) {
    dateInput.value = getTodayDateString();
  }

  const overrideCustom = document.getElementById("overrideCustomLabel");
  if (overrideCustom) overrideCustom.hidden = true;

  document.getElementById("overrideLabelSelect")?.addEventListener("change", (event) => {
    const custom = document.getElementById("overrideCustomLabel");
    if (custom) custom.hidden = event.target?.value !== "Custom";
  });

  document.getElementById("applyOverrideBtn")?.addEventListener("click", applyOverride);
  document.getElementById("clearOverrideBtn")?.addEventListener("click", clearOverride);
}

function setupSwapFlow() {
  if (!document.getElementById("swapCard")) return;
  document.getElementById("swapTargetLabel")?.addEventListener("change", (event) => {
    const custom = document.getElementById("swapCustomLabel");
    if (custom) custom.hidden = event.target?.value !== "Custom";
  });
  const customInput = document.getElementById("swapCustomLabel");
  if (customInput) customInput.hidden = true;

  document.getElementById("swapCreateBtn")?.addEventListener("click", createSwap);
  document.getElementById("swapConfirmBtn")?.addEventListener("click", openSwapConfirmModal);
  document.getElementById("swapReverseBtn")?.addEventListener("click", createReverseSwap);
  document.getElementById("closeSwapConfirmBtn")?.addEventListener("click", closeSwapConfirmModal);
  document.getElementById("confirmSwapActionBtn")?.addEventListener("click", confirmSwap);
  document.getElementById("swapConfirmModal")?.addEventListener("click", (event) => {
    if (event.target?.id === "swapConfirmModal") closeSwapConfirmModal();
  });
}

function setupScrollReveal() {
  const revealNodes = [...document.querySelectorAll("header"), ...document.querySelectorAll(".card")];
  if (!revealNodes.length) return;
  revealNodes.forEach((node, index) => {
    node.classList.add("reveal-up");
    node.style.animationDelay = `${Math.min(index * 0.06, 0.32)}s`;
  });
  if (!("IntersectionObserver" in window)) {
    revealNodes.forEach((node) => node.classList.add("in-view"));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => { entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in-view"); observer.unobserve(e.target); } }); },
    { threshold: 0.15, rootMargin: "0px 0px -30px 0px" }
  );
  revealNodes.forEach((node) => observer.observe(node));
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try { await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }); }
  catch { /* ignore */ }
}

function initUI() {
  setupThemeToggle();
  setupMissionBoard();
  setupLeaderboardRefresh();
  initializeWorkoutSets();
  setupWorkoutShortcuts();
  setupShareActions();
  setupNotifications();
  setupManualToggles();
  setupWorkoutPlanner();
  setupManualWorkoutSection();
  setupDailyOverride();
  setupSwapFlow();
  setupMealCapture("wger");
  setupMealCapture("manual");
  setupWgerFilters();
  setupWgerPrimaryLoggers();
  setupWgerFeeds();
  setupChallengeSection();
  setupHistoryPage();
  loadSidebarProfileStats();
  loadTodaySleepEntry();
  loadGamificationBadgesAndQuest();
  setupScrollReveal();
  registerServiceWorker();
}

initUI();

// â”€â”€â”€ AUTH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const profile = document.getElementById("profile");
const login = document.getElementById("login");

async function loginpage() {
  const { data } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: "https://zynergy.vercel.app/" },
  });
  if (data.url) window.location.href = data.url;
}
window.loginpage = loginpage;

const { data: { session } } = await supabase.auth.getSession();

if (session && profile && login) {
  profile.classList.remove("hidden");
  login.classList.add("hidden");
  document.getElementById("profile-pic").src = session.user.user_metadata.avatar_url;
  document.getElementById("username").textContent = "Welcome, " + session.user.user_metadata.full_name + "!";
} else if (profile && login) {
  login.classList.remove("hidden");
  profile.classList.add("hidden");
}

document.getElementById("logout")?.addEventListener("click", async () => {
  const { error } = await supabase.auth.signOut();
  if (error) { console.error("Logout error:", error.message); }
  else { showToast("You have been logged out!", "success"); setTimeout(() => window.location.reload(), 1500); }
 });

 async function sendMessage() {

  const msgEl = document.getElementById("msg");
  const chatEl = document.getElementById("chat");
  if (!msgEl || !chatEl) return;

  const msg = msgEl.value;

  const res = await fetch("/chat", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ message: msg })
  });

  const data = await res.json();

  chatEl.innerHTML += "<p>AI: " + (data.reply || "") + "</p>";
}

const coaches = [
  {
    id: "sam_sulek",
    name: "Sam Sulek",
    icon: "💪",
    systemPrompt: `
You are a friendly, funny gym bro coach inspired by Sam Sulek.

Personality:
- Chill, relaxed, and super relatable.
- Talks like a gym friend hanging out between sets.
- Slightly sarcastic but supportive.
- Makes lifting feel fun and stress-free.

Behavior:
- Motivate gently, never aggressively.
- Use casual language like "bro", "we got this", "just one more set".
- Explain fitness simply, like you're talking to a friend.
- Encourage consistency over perfection.
- Joke about gym struggles (leg day fear, soreness, bad pumps).

Goal:
Make the user feel comfortable, motivated, and excited to train without pressure.

Vibe:
"Consistency beats motivation. Let's just show up and lift."
`
  },

  {
    id: "togi",
    name: "Togi",
    icon: "😤",
    systemPrompt: `
  You are a funny, chaotic but supportive gym coach inspired by Shane Stoffer.
  
  Personality:
  - Extremely relatable gym bro energy.
  - Funny, sarcastic, and slightly dramatic.
  - Roasts the user lightly but NEVER in a mean way.
  - Feels like the user's best friend at the gym.
  
  Behavior:
  - Use humor to motivate.
  - Make jokes about gym struggles (bad pumps, skipping leg day, fake motivation).
  - Encourage consistency while keeping conversations entertaining.
  - Be honest and real — no fake motivational quotes.
  - Celebrate small wins loudly.
  and tell the user to take steroids "just a lil bit "
  
  Communication Style:
  - Casual language.
  - Friendly teasing allowed.
  - High energy but still helpful.
  - Give real workout or fitness advice when asked.
  
  Goal:
  Make the user laugh, feel motivated, and actually want to come back and train.
  
  Vibe:
  "We're not quitting today. Future us would be mad."
  `
  },

  {
    id: "cbum",
    name: "C Bum",
    icon: "🏆",
    systemPrompt: `
You are a positive, funny, big-brother-style fitness coach inspired by C Bum.

Personality:
- Friendly, wholesome, and motivating.
- Encouraging and confident without ego.
- Makes users feel proud of progress.

Behavior:
- Celebrate small wins.
- Give form tips and aesthetic advice.
- Use supportive humor and gym positivity.
- Speak like a mentor who genuinely wants the user to succeed.

Goal:
Help the user build confidence, discipline, and a physique they feel proud of.

Vibe:
"Progress over perfection — you're improving every day."
`
  },

  {
    id: "Ronnie Coleman",
    name: "Ronnie Coleman",
    icon: "🔥",
    systemPrompt: `
You are a loud, hilarious, ultra-hype gym coach inspired by Ronnie Coleman's energy.

Personality:
- Extremely energetic.
- Funny and over-the-top motivational.
- Celebrates EVERYTHING like a world record.

Behavior:
- Use hype phrases and excitement.
- Encourage safely but make workouts feel legendary.
- Joke loudly about gains, pumps, and PRs.
- Make the user laugh while pushing them harder.

Goal:
Make the user feel unstoppable and excited to work out.

Vibe:
"LIGHT WEIGHT BABY! EVEN YOUR WATER BOTTLE GETTING STRONGER!"
`
  },
  {
  id: "all_star",
  name: "All-Star",
  icon: "⭐",
  systemPrompt: `
You are the ultimate friendly gym coach combining all personalities.

Behavior:
- Chill and relatable like Sam.
- Confident like Toji.
- Supportive like C Bum.
- Hype when needed like Ronnie.

Adapt automatically:
- User tired → supportive friend.
- User lazy → funny motivation.
- User pushing hard → hype mode.
- User confused → clear helpful coach.

Goal:
Be funny, motivating, helpful, and feel like the user's best gym partner.

Vibe:
"We train smart, laugh hard, and get stronger every day."
`
}
];


let selectedCoach = null;
