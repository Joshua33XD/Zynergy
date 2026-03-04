
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
  
  if (!session || !session.user) {
    return null;
  }
  
  return {
    user_id: session.user.id,
    username: session.user.user_metadata?.full_name || session.user.email?.split("@")[0] || "User",
  };
}

// Helper function for upsert with fallback logic
async function upsertWithFallback(tableName, data, conflictColumns) {
  let { data: result, error } = await supabase.from(tableName).upsert(data);

  // If upsert fails due to onConflict format, try with explicit onConflict
  if (error && error.message?.includes("onConflict")) {
    const retry = await supabase.from(tableName).upsert(data, {
      onConflict: conflictColumns,
    });
    result = retry.data;
    error = retry.error;
  }

  // If upsert still fails, try manual check-then-insert-or-update
  if (error && (error.code === "23505" || error.message?.includes("duplicate"))) {
    // Parse conflict columns (handle quoted names like "Date")
    const conflictCols = conflictColumns.split(",").map((col) => {
      const cleaned = col.trim().replace(/"/g, "");
      return cleaned;
    });
    
    const conflictConditions = conflictCols.map((col) => {
      // Try both the cleaned name and the original quoted name
      const value = data[col] !== undefined ? data[col] : data[`"${col}"`];
      return {
        column: col,
        value: value,
      };
    });

    // Build query to check if row exists
    let query = supabase.from(tableName).select(conflictCols[0]);
    conflictConditions.forEach(({ column, value }) => {
      query = query.eq(column, value);
    });
    const { data: existing } = await query.single();

    if (existing) {
      // Update existing row
      let updateQuery = supabase.from(tableName).update(data);
      conflictConditions.forEach(({ column, value }) => {
        updateQuery = updateQuery.eq(column, value);
      });
      const updateResult = await updateQuery;
      result = updateResult.data;
      error = updateResult.error;
    } else {
      // Try insert anyway
      const insertResult = await supabase.from(tableName).insert(data);
      result = insertResult.data;
      error = insertResult.error;
    }
  }

  return { data: result, error };
}

// Helper function for error handling
function handleError(error, tableName, user_id, date) {
  const isDuplicate =
    error.code === "23505" ||
    error.message?.toLowerCase().includes("duplicate key");

  const isRLSError =
    error.message?.toLowerCase().includes("row-level security") ||
    error.message?.toLowerCase().includes("permission denied") ||
    error.code === "42501" ||
    error.message?.toLowerCase().includes("new row violates row-level security policy");

  if (isDuplicate) {
    return `Duplicate: you already have an entry for ${date}. The form now uses upsert—if you still see this, an UPDATE policy may be missing for '${tableName}'. Error: ${error.message}`;
  } else if (isRLSError) {
    return `RLS Error: ${error.message}\n\nThis usually means:\n1. RLS is enabled but no policy allows INSERT/UPDATE for your user\n2. Your user_id doesn't match the policy conditions\n\nUser ID: ${user_id}\n\nCheck your Supabase RLS policies for the '${tableName}' table.`;
  } else {
    return `Save failed: ${error.message}`;
  }
}

const uiState = {
  setCount: 0,
  sessionXp: 0,
};

const wgerState = {
  exercises: [],
  ingredients: [],
  filteredExercises: [],
  filteredIngredients: [],
  muscleLookup: {},
  workoutReady: false,
  nutritionReady: false,
};

function showXpPop(text) {
  const xpPop = document.getElementById("xpPop");
  if (!xpPop) return;
  xpPop.textContent = text;
  xpPop.classList.remove("show");
  void xpPop.offsetWidth;
  xpPop.classList.add("show");
}

function animateMeterById(id, percent) {
  const meter = document.getElementById(id);
  if (!meter) return;
  const clamped = Math.max(0, Math.min(100, percent));
  meter.style.width = `${clamped}%`;
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
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  new Notification(title, { body });
}

function applyTheme(themeName) {
  if (!themeName || themeName === "default") {
    document.body.removeAttribute("data-theme");
    return;
  }
  document.body.setAttribute("data-theme", themeName);
}

async function getValues() {
  // Check authentication first (required for RLS)
  const userInfo = await getUserInfo();
  if (!userInfo) {
    alert("You must be logged in to save workouts. Please log in first.");
    return;
  }

  const { user_id, username } = userInfo;

  const intensityRaw = document.getElementById("workout-intensity")?.value;
  const mg1Raw = document.getElementById("muscle-group")?.value;
  const mg2Raw = document.getElementById("muscle-group2")?.value;
  const energyRaw = document.getElementById("energy-level")?.value;

  const workout_intensity =
    intensityRaw != null
      ? intensityRaw[0].toUpperCase() + intensityRaw.slice(1).toLowerCase()
      : null;

  const muscleMap = {
    chest: "Chest",
    back: "Back",
    legs: "Leg",
    leg: "Leg",
    bicep: "Bicep",
    tricep: "Tricep",
    shoulders: "Shoulder",
    shoulder: "Shoulder",
  };
  const mg1 = mg1Raw ? muscleMap[mg1Raw] ?? null : null;
  const mg2 = mg2Raw ? muscleMap[mg2Raw] ?? null : null;
  const muscle_groups = [mg1, mg2].filter(Boolean);

  const energy_level = energyRaw != null ? parseInt(energyRaw, 10) : null;

  const date = new Date().toISOString().split("T")[0];
  const workout_status = "Workout done";

  // Validate intensity/energy combination per workout_daily_check1 constraint
  let validationError = null;
  if (workout_intensity && energy_level != null) {
    if (workout_intensity === "Light" && (energy_level < 3 || energy_level > 5)) {
      validationError = `Light workouts require energy level 3-5, but you selected ${energy_level}`;
    } else if (workout_intensity === "Moderate" && (energy_level < 2 || energy_level > 4)) {
      validationError = `Moderate workouts require energy level 2-4, but you selected ${energy_level}`;
    } else if (workout_intensity === "Intense" && (energy_level < 1 || energy_level > 2)) {
      validationError = `Intense workouts require energy level 1-2, but you selected ${energy_level}`;
    }
  }

  if (validationError) {
    alert("Validation failed: " + validationError);
    return;
  }

  const { data, error } = await upsertWithFallback(
    "workout_daily",
    {
      user_id,
      username,
      date,
      workout_status,
      workout_intensity,
      muscle_groups,
      energy_level,
    },
    "user_id,date"
  );

  if (error) {
    alert(handleError(error, "workout_daily", user_id, date));
  } else {
    uiState.sessionXp += 30;
    animateNumber("sessionXp", uiState.sessionXp);
    animateMeterById("sessionXpMeter", Math.min(100, uiState.sessionXp));
    showXpPop("+30 XP");
    maybeNotify("Workout saved", "Mission progress increased.");
    alert("Workout saved successfully!");
  }
}

async function saveSleepData() {
  // Check authentication first (required for RLS)
  const userInfo = await getUserInfo();
  if (!userInfo) {
    alert("You must be logged in to save sleep data. Please log in first.");
    return;
  }

  const { user_id, username } = userInfo;

  const hoursSleptRaw = document.getElementById("sleepInput")?.value;
  const emojiRaw = document.getElementById("emojiSelect")?.value;

  if (!hoursSleptRaw || !emojiRaw) {
    alert("Please fill in all sleep fields.");
    return;
  }

  const hours_slept = parseFloat(hoursSleptRaw);
  const date = new Date().toISOString().split("T")[0];

  // Map emoji values to actual emoji strings
  const emojiMap = {
    emoji1: "😴🛌💤",
    emoji2: "😃☀️🌞",
    emoji3: "😬☕🥱",
    emoji4: "😡⏰😒",
    emoji5: "🏃‍♂️💨⏱️",
  };
  const sleep_emoji = emojiMap[emojiRaw] || emojiRaw;

  // Validate hours_slept constraint (0-12)
  if (hours_slept < 0 || hours_slept > 12) {
    alert(`Hours slept must be between 0 and 12, but you entered ${hours_slept}`);
    return;
  }

  // Validate sleep_emoji constraint
  const validEmojis = ["😴🛌💤", "😃☀️🌞", "😬☕🥱", "😡⏰😒", "🏃‍♂️💨⏱️"];
  if (!validEmojis.includes(sleep_emoji)) {
    alert(`Invalid sleep emoji. Please select a valid option.`);
    return;
  }

  const { data, error } = await upsertWithFallback(
    "daily_sleep",
    {
      user_id,
      username,
      Date: date,
      hours_slept,
      sleep_emoji,
    },
    'user_id,"Date"'
  );

  if (error) {
    alert(handleError(error, "daily_sleep", user_id, date));
  } else {
    showXpPop("+10 XP");
    animateMeterById("sleepMeter", Math.min(100, hours_slept * 10));
    maybeNotify("Sleep log saved", `Recovery updated: ${hours_slept}h`);
    alert("Sleep data saved successfully!");
  }
}

async function saveNutritionData() {
  // Check authentication first (required for RLS)
  const userInfo = await getUserInfo();
  if (!userInfo) {
    alert("You must be logged in to save nutrition data. Please log in first.");
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

  // Validate required fields
  if (!breakfast || !lunch || !dinner || !snacks) {
    alert("Please fill in all meal fields (breakfast, lunch, dinner, snacks).");
    return;
  }

  const entry_date = new Date().toISOString().split("T")[0];

  // Convert checkboxes to Yes/No format per constraint
  const hydration_goal_met = hydration ? "Yes" : "No";
  const protein_goal_met = protein ? "Yes" : "No";
  const balanced_meal_goal_met = balancedMeal ? "Yes" : "No";

  const { data, error } = await upsertWithFallback(
    "daily_nutrition",
    {
      user_id,
      username,
      entry_date,
      breakfast,
      lunch,
      dinner,
      snacks,
      hydration_goal_met,
      protein_goal_met,
      balanced_meal_goal_met,
      notes_or_regrets: notes,
    },
    "user_id,entry_date"
  );

  if (error) {
    alert(handleError(error, "daily_nutrition", user_id, entry_date));
  } else {
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
    maybeNotify("Nutrition saved", "Fuel goals updated.");
    alert("Nutrition data saved successfully!");
  }
}

window.getValues = getValues;
window.saveSleepData = saveSleepData;
window.saveNutritionData = saveNutritionData;

function setupWorkoutShortcuts() {
  const workoutPage = document.getElementById("workout");
  if (!workoutPage) return;

  const setCounter = document.getElementById("setCounter");
  const addSetBtn = document.getElementById("addSetBtn");
  const addWeightBtn = document.getElementById("addWeightBtn");
  const repeatWorkoutBtn = document.getElementById("repeatWorkoutBtn");
  const weightInput = document.getElementById("workout-weight");
  const intensity = document.getElementById("workout-intensity");
  const muscle1 = document.getElementById("muscle-group");
  const muscle2 = document.getElementById("muscle-group2");
  const energy = document.getElementById("energy-level");

  const addSet = () => {
    uiState.setCount += 1;
    uiState.sessionXp += 20;
    if (setCounter) setCounter.textContent = `Sets logged: ${uiState.setCount}`;
    animateNumber("sessionXp", uiState.sessionXp);
    animateMeterById("sessionXpMeter", Math.min(100, uiState.sessionXp));
    showXpPop("+20 XP");
  };

  addSetBtn?.addEventListener("click", addSet);

  addWeightBtn?.addEventListener("click", () => {
    if (!weightInput) return;
    const next = (parseFloat(weightInput.value || "0") || 0) + 5;
    weightInput.value = String(next);
    showXpPop("+5kg");
  });

  repeatWorkoutBtn?.addEventListener("click", () => {
    const cached = localStorage.getItem("lastWorkoutPreset");
    if (!cached) return;
    try {
      const value = JSON.parse(cached);
      if (intensity && value.intensity) intensity.value = value.intensity;
      if (muscle1 && value.muscle1) muscle1.value = value.muscle1;
      if (muscle2 && value.muscle2) muscle2.value = value.muscle2;
      if (energy && value.energy) energy.value = value.energy;
      if (weightInput && value.weight) weightInput.value = value.weight;
      showXpPop("Preset loaded");
    } catch {
      // Ignore invalid cached data
    }
  });

  document.addEventListener("keydown", (event) => {
    const activeTag = document.activeElement?.tagName;
    const typing = activeTag === "INPUT" || activeTag === "TEXTAREA";

    if (event.code === "Space" && !typing) {
      event.preventDefault();
      addSet();
    }
    if (event.key === "ArrowRight" && !typing) {
      event.preventDefault();
      addWeightBtn?.click();
    }
    if (event.key === "Enter" && !typing) {
      event.preventDefault();
      workoutPage.click();
    }
    if ((event.key === "r" || event.key === "R") && !typing) {
      event.preventDefault();
      repeatWorkoutBtn?.click();
    }
  });

  workoutPage.addEventListener("click", () => {
    const payload = {
      intensity: intensity?.value,
      muscle1: muscle1?.value,
      muscle2: muscle2?.value,
      energy: energy?.value,
      weight: weightInput?.value,
    };
    localStorage.setItem("lastWorkoutPreset", JSON.stringify(payload));
  });
}

function setupShareActions() {
  const copyBtn = document.getElementById("copyShareBtn");
  const downloadBtn = document.getElementById("downloadShareBtn");
  const whatsAppBtn = document.getElementById("shareWhatsAppBtn");
  const shareCard = document.getElementById("shareCard");

  copyBtn?.addEventListener("click", async () => {
    const text = "NEW PR: Deadlift 140kg. Level Up -> 15";
    try {
      await navigator.clipboard.writeText(text);
      showXpPop("Copied");
    } catch {
      alert(text);
    }
  });

  downloadBtn?.addEventListener("click", () => {
    const text = "NEW PR\nDeadlift 140kg\nLevel Up -> 15";
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "zynergy-pr-card.txt";
    a.click();
    URL.revokeObjectURL(url);
    if (shareCard) shareCard.classList.add("shake");
    setTimeout(() => shareCard?.classList.remove("shake"), 700);
  });

  whatsAppBtn?.addEventListener("click", () => {
    const msg = encodeURIComponent("NEW PR! Deadlift 140kg. Level Up to 15.");
    window.open(`https://wa.me/?text=${msg}`, "_blank");
  });
}

function setupNotifications() {
  const notifyBtn = document.getElementById("notifyEnableBtn");
  notifyBtn?.addEventListener("click", async () => {
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

  const labelMap = {
    default: "Theme: Black",
    ion: "Theme: Blue",
  };
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
  const missionList = document.getElementById("missionList");
  if (!missionList) return;

  const missionButtons = missionList.querySelectorAll(".mission-toggle");
  const missionPct = document.getElementById("missionPct");
  const updateMissionProgress = () => {
    const done = missionList.querySelectorAll("li.done").length;
    const total = missionButtons.length;
    const percent = Math.round((done / total) * 100);
    if (missionPct) missionPct.textContent = `${percent}%`;
    animateMeterById("missionMeter", percent);
  };

  missionButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = btn.closest("li");
      if (!item) return;
      const nowDone = !item.classList.contains("done");
      item.classList.toggle("done", nowDone);
      btn.textContent = nowDone ? "Done" : "Pending";
      const xpReward = Number(btn.dataset.xp || "10");
      if (nowDone) {
        const xpNode = document.getElementById("xpValue");
        const currentXp = Number(xpNode?.textContent || "0");
        animateNumber("xpValue", currentXp + xpReward);
        showXpPop(`+${xpReward} XP`);
      }
      updateMissionProgress();
    });
  });

  updateMissionProgress();
}

function setupLeaderboardRefresh() {
  const list = document.getElementById("leaderboardList");
  const refreshBtn = document.getElementById("refreshBoardBtn");
  if (!list || !refreshBtn) return;

  refreshBtn.addEventListener("click", () => {
    const entries = Array.from(list.querySelectorAll("li"));
    for (let i = entries.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [entries[i], entries[j]] = [entries[j], entries[i]];
    }
    list.replaceChildren(...entries);
    showXpPop("Board refreshed");
  });
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

function setSourceMode({
  ready,
  wgerCardId,
  manualCardId,
  statusId,
  manualToggleId,
  readyText,
  fallbackText,
}) {
  const wgerCard = document.getElementById(wgerCardId);
  const manualCard = document.getElementById(manualCardId);
  const status = document.getElementById(statusId);
  const toggleBtn = document.getElementById(manualToggleId);

  if (status) status.textContent = ready ? readyText : fallbackText;

  if (!wgerCard || !manualCard) return;

  if (ready) {
    wgerCard.classList.remove("hidden");
    manualCard.classList.add("hidden");
    if (toggleBtn) {
      toggleBtn.textContent = "Use Manual Logger";
    }
    return;
  }

  // Automatic failover: manual logger becomes the primary visible UI.
  wgerCard.classList.add("hidden");
  manualCard.classList.remove("hidden");
}

function setupManualToggles() {
  const workoutManualToggle = document.getElementById("workoutManualToggle");
  const nutritionManualToggle = document.getElementById("nutritionManualToggle");

  workoutManualToggle?.addEventListener("click", () => {
    const manualCard = document.getElementById("manualWorkoutCard");
    if (!manualCard) return;
    const showing = !manualCard.classList.contains("hidden");
    manualCard.classList.toggle("hidden", showing);
    workoutManualToggle.textContent = showing ? "Use Manual Logger" : "Hide Manual Logger";
  });

  nutritionManualToggle?.addEventListener("click", () => {
    const manualCard = document.getElementById("manualNutritionCard");
    if (!manualCard) return;
    const showing = !manualCard.classList.contains("hidden");
    manualCard.classList.toggle("hidden", showing);
    nutritionManualToggle.textContent = showing ? "Use Manual Logger" : "Hide Manual Logger";
  });
}

function normalizeWgerExercise(exercise) {
  const translations = Array.isArray(exercise.translations) ? exercise.translations : [];
  const translated =
    translations.find((item) => item.language === 2 && (item.name || item.description)) ||
    translations.find((item) => item.name || item.description) ||
    null;

  return {
    id: exercise.id ?? exercise.uuid,
    name:
      translated?.name ||
      exercise.name ||
      exercise.exercise_base_name ||
      exercise.uuid ||
      "Unnamed exercise",
    description: stripHtml(translated?.description || exercise.description || ""),
  };
}

function fillWgerExerciseSelect(exercises) {
  const select = document.getElementById("wgerExerciseSelect");
  if (!select) return;

  select.replaceChildren();
  if (!exercises.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No exercises for this muscle group";
    select.appendChild(option);
    return;
  }

  exercises.forEach((exercise, idx) => {
    const option = document.createElement("option");
    option.value = String(exercise.id ?? idx);
    option.textContent = exercise.name;
    if (idx === 0) option.selected = true;
    select.appendChild(option);
  });
}

function fillWgerIngredientSelect(ingredients) {
  const select = document.getElementById("wgerIngredientSelect");
  if (!select) return;

  select.replaceChildren();
  if (!ingredients.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No ingredients for this nutrition focus";
    select.appendChild(option);
    return;
  }

  ingredients.forEach((ingredient, idx) => {
    const option = document.createElement("option");
    option.value = String(ingredient.id ?? idx);
    option.textContent = ingredient.name || "Unnamed ingredient";
    if (idx === 0) option.selected = true;
    select.appendChild(option);
  });
}

function extractIdArray(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      if (typeof item === "number") return item;
      if (item && typeof item.id === "number") return item.id;
      return null;
    })
    .filter((id) => Number.isFinite(id));
}

function fillWgerMuscleSelect(exercises, lookup) {
  const select = document.getElementById("wgerMuscleFocus");
  if (!select) return;

  const ids = new Set();
  exercises.forEach((exercise) => {
    (exercise.muscleIds || []).forEach((id) => ids.add(id));
  });

  const previous = select.value || "";
  select.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select muscle group";
  placeholder.selected = true;
  select.appendChild(placeholder);

  Array.from(ids)
    .sort((a, b) => a - b)
    .forEach((id) => {
      const option = document.createElement("option");
      option.value = String(id);
      option.textContent = lookup[id] || `Muscle ${id}`;
      if (previous && previous === option.value) option.selected = true;
      select.appendChild(option);
    });
}

function applyExerciseFilterByMuscle() {
  const muscleSelect = document.getElementById("wgerMuscleFocus");
  if (!muscleSelect) return;

  const muscleId = Number(muscleSelect.value);
  if (!muscleId) {
    wgerState.filteredExercises = [];
    fillWgerExerciseSelect([]);
    return;
  }

  const filtered = wgerState.exercises.filter((exercise) =>
    (exercise.muscleIds || []).includes(muscleId)
  );
  wgerState.filteredExercises = filtered;
  fillWgerExerciseSelect(filtered);
}

function applyNutritionFocusFilter() {
  const focusSelect = document.getElementById("wgerFoodFocus");
  if (!focusSelect) return;

  const focus = focusSelect.value;
  if (!focus) {
    wgerState.filteredIngredients = [];
    fillWgerIngredientSelect([]);
    return;
  }

  const scored = [...wgerState.ingredients].map((ingredient) => {
    const protein = Number(ingredient.protein || 0);
    const carbs = Number(ingredient.carbohydrates || 0);
    const fat = Number(ingredient.fat || 0);
    const total = protein + carbs + fat;

    let score = 0;
    if (focus === "protein") score = protein;
    if (focus === "carbs") score = carbs;
    if (focus === "fat") score = fat;
    if (focus === "balanced") {
      const p = total ? protein / total : 0;
      const c = total ? carbs / total : 0;
      const f = total ? fat / total : 0;
      score = 1 - (Math.abs(p - 0.33) + Math.abs(c - 0.33) + Math.abs(f - 0.34));
    }

    return { ingredient, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const filtered = scored.slice(0, 25).map((entry) => entry.ingredient);
  wgerState.filteredIngredients = filtered;
  fillWgerIngredientSelect(filtered);
}

async function loadWgerExercises() {
  const listEl = document.getElementById("exercise-list");
  const statusEl = document.getElementById("exerciseStatus");
  if (!listEl) return false;

  if (statusEl) statusEl.textContent = "Loading exercises...";

  try {
    const [exerciseResponse, muscleResponse] = await Promise.all([
      fetch("https://wger.de/api/v2/exerciseinfo/?language=2&limit=60"),
      fetch("https://wger.de/api/v2/muscle/?language=2&limit=200"),
    ]);

    if (!exerciseResponse.ok) {
      throw new Error(`HTTP ${exerciseResponse.status}`);
    }

    const data = await exerciseResponse.json();
    let muscleLookup = {};
    if (muscleResponse.ok) {
      const muscleData = await muscleResponse.json();
      const muscleResults = Array.isArray(muscleData.results) ? muscleData.results : [];
      muscleLookup = muscleResults.reduce((acc, item) => {
        const id = item?.id;
        const name = item?.name_en || item?.name || item?.muscle || "";
        if (typeof id === "number" && name) acc[id] = name;
        return acc;
      }, {});
    }

    const results = Array.isArray(data.results) ? data.results : [];
    const exercises = results.map((exercise) => ({
      ...normalizeWgerExercise(exercise),
      muscleIds: [
        ...extractIdArray(exercise.muscles),
        ...extractIdArray(exercise.muscles_secondary),
      ],
    }));

    wgerState.exercises = exercises;
    wgerState.muscleLookup = muscleLookup;
    fillWgerMuscleSelect(exercises, muscleLookup);
    fillWgerExerciseSelect([]);

    listEl.replaceChildren();
    exercises.forEach((exercise) => {
      const card = document.createElement("article");
      card.className = "api-item";

      const title = document.createElement("h3");
      title.textContent = exercise.name;

      const description = document.createElement("p");
      description.textContent = exercise.description || "No description available.";

      card.append(title, description);
      listEl.appendChild(card);
    });

    if (statusEl) {
      statusEl.textContent = results.length
        ? `Loaded ${results.length} exercises from Wger.`
        : "No exercises found from Wger.";
    }

    return results.length > 0;
  } catch (error) {
    renderApiError(statusEl, listEl, "Could not load exercises from Wger right now.");
    console.error("Wger exercise fetch failed:", error);
    fillWgerMuscleSelect([], {});
    fillWgerExerciseSelect([]);
    return false;
  }
}

async function loadWgerNutrition() {
  const listEl = document.getElementById("nutrition-list");
  const statusEl = document.getElementById("nutritionStatus");
  if (!listEl) return false;

  if (statusEl) statusEl.textContent = "Loading nutrition data...";

  try {
    const response = await fetch("https://wger.de/api/v2/ingredient/?language=2&limit=8");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const results = Array.isArray(data.results) ? data.results : [];
    wgerState.ingredients = results;
    fillWgerIngredientSelect([]);

    listEl.replaceChildren();
    results.forEach((ingredient) => {
      const card = document.createElement("article");
      card.className = "api-item";

      const title = document.createElement("h3");
      title.textContent = ingredient.name || "Unnamed ingredient";

      const detail = document.createElement("p");
      detail.textContent = `Energy: ${ingredient.energy ?? "?"} kcal / 100g`;

      const pills = document.createElement("div");
      pills.className = "api-pill-row";

      const values = [
        formatMacro("Protein", ingredient.protein),
        formatMacro("Carbs", ingredient.carbohydrates),
        formatMacro("Fat", ingredient.fat),
      ].filter(Boolean);

      if (!values.length) {
        const fallback = document.createElement("span");
        fallback.className = "api-pill";
        fallback.textContent = "Macros unavailable";
        pills.appendChild(fallback);
      } else {
        values.forEach((value) => {
          const pill = document.createElement("span");
          pill.className = "api-pill";
          pill.textContent = value;
          pills.appendChild(pill);
        });
      }

      card.append(title, detail, pills);
      listEl.appendChild(card);
    });

    if (statusEl) {
      statusEl.textContent = results.length
        ? `Loaded ${results.length} nutrition items from Wger.`
        : "No nutrition items found from Wger.";
    }

    return results.length > 0;
  } catch (error) {
    renderApiError(statusEl, listEl, "Could not load nutrition data from Wger right now.");
    console.error("Wger nutrition fetch failed:", error);
    fillWgerIngredientSelect([]);
    return false;
  }
}

function setupWgerFilters() {
  const muscleSelect = document.getElementById("wgerMuscleFocus");
  const foodFocusSelect = document.getElementById("wgerFoodFocus");
  muscleSelect?.addEventListener("change", applyExerciseFilterByMuscle);
  foodFocusSelect?.addEventListener("change", applyNutritionFocusFilter);
}

function capitalizeFirst(text) {
  if (!text) return "";
  return text[0].toUpperCase() + text.slice(1).toLowerCase();
}

async function saveWorkoutViaWger() {
  const userInfo = await getUserInfo();
  if (!userInfo) {
    alert("You must be logged in to save workouts. Please log in first.");
    return;
  }

  const muscleFocus = document.getElementById("wgerMuscleFocus")?.value || "";
  const exerciseSelect = document.getElementById("wgerExerciseSelect");
  const sets = Number(document.getElementById("wgerSets")?.value || 0);
  const reps = Number(document.getElementById("wgerReps")?.value || 0);
  const intensityRaw = document.getElementById("wgerWorkoutIntensity")?.value || "moderate";
  const energyRaw = Number(document.getElementById("wgerWorkoutEnergy")?.value || 3);

  if (!muscleFocus) {
    alert("Choose a muscle group first.");
    return;
  }
  if (!exerciseSelect?.value) {
    alert("Please select an exercise from Wger.");
    return;
  }
  if (sets <= 0 || reps <= 0) {
    alert("Sets and reps must be greater than 0.");
    return;
  }

  const exercise = wgerState.exercises.find((item) => String(item.id) === exerciseSelect.value);
  const exerciseName = exercise?.name || exerciseSelect.options[exerciseSelect.selectedIndex]?.text || "Exercise";
  const date = new Date().toISOString().split("T")[0];
  const intensity = capitalizeFirst(intensityRaw);

  const { user_id, username } = userInfo;
  const { error } = await upsertWithFallback(
    "workout_daily",
    {
      user_id,
      username,
      date,
      workout_status: `Wger log: ${exerciseName} (${sets}x${reps})`,
      workout_intensity: intensity,
      muscle_groups: [],
      energy_level: energyRaw,
    },
    "user_id,date"
  );

  if (error) {
    alert(handleError(error, "workout_daily", user_id, date));
    return;
  }

  uiState.sessionXp += 30;
  animateNumber("sessionXp", uiState.sessionXp);
  animateMeterById("sessionXpMeter", Math.min(100, uiState.sessionXp));
  showXpPop("+30 XP");
  maybeNotify("Workout saved", `${exerciseName} saved through Wger.`);
  alert("Workout saved successfully via Wger!");
}

async function saveNutritionViaWger() {
  const userInfo = await getUserInfo();
  if (!userInfo) {
    alert("You must be logged in to save nutrition data. Please log in first.");
    return;
  }

  const foodFocus = document.getElementById("wgerFoodFocus")?.value || "";
  const ingredientSelect = document.getElementById("wgerIngredientSelect");
  const grams = Number(document.getElementById("wgerGrams")?.value || 0);
  const mealType = document.getElementById("wgerMealType")?.value || "snacks";
  const hydration = document.getElementById("wgerHydration")?.checked || false;
  const protein = document.getElementById("wgerProtein")?.checked || false;
  const balancedMeal = document.getElementById("wgerBalancedMeal")?.checked || false;

  if (!foodFocus) {
    alert("Choose nutrition focus first.");
    return;
  }
  if (!ingredientSelect?.value) {
    alert("Please select an ingredient from Wger.");
    return;
  }
  if (grams <= 0) {
    alert("Amount must be greater than 0 grams.");
    return;
  }

  const ingredient = wgerState.ingredients.find((item) => String(item.id) === ingredientSelect.value);
  const ingredientName =
    ingredient?.name || ingredientSelect.options[ingredientSelect.selectedIndex]?.text || "Ingredient";
  const entryText = `${ingredientName} (${grams}g)`;

  const meals = {
    breakfast: "-",
    lunch: "-",
    dinner: "-",
    snacks: "-",
  };
  meals[mealType] = entryText;

  const notes = [
    `Wger item: ${entryText}`,
    ingredient?.energy != null ? `Energy: ${ingredient.energy} kcal/100g` : null,
    ingredient?.protein != null ? `Protein: ${ingredient.protein}g/100g` : null,
  ]
    .filter(Boolean)
    .join(" | ");

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
      notes_or_regrets: notes || null,
    },
    "user_id,entry_date"
  );

  if (error) {
    alert(handleError(error, "daily_nutrition", user_id, entry_date));
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
  alert("Nutrition data saved successfully via Wger!");
}

function setupWgerPrimaryLoggers() {
  const workoutSaveBtn = document.getElementById("wgerWorkoutSaveBtn");
  const nutritionSaveBtn = document.getElementById("wgerNutritionSaveBtn");
  workoutSaveBtn?.addEventListener("click", saveWorkoutViaWger);
  nutritionSaveBtn?.addEventListener("click", saveNutritionViaWger);
}

async function setupWgerFeeds() {
  const [workoutReady, nutritionReady] = await Promise.all([
    loadWgerExercises(),
    loadWgerNutrition(),
  ]);

  wgerState.workoutReady = workoutReady;
  wgerState.nutritionReady = nutritionReady;

  setSourceMode({
    ready: workoutReady,
    wgerCardId: "wgerWorkoutCard",
    manualCardId: "manualWorkoutCard",
    statusId: "workoutSourceStatus",
    manualToggleId: "workoutManualToggle",
    readyText: "Wger available. Logging through Wger flow.",
    fallbackText: "Wger unavailable. Manual workout logger enabled as fallback.",
  });

  setSourceMode({
    ready: nutritionReady,
    wgerCardId: "wgerNutritionCard",
    manualCardId: "manualNutritionCard",
    statusId: "nutritionSourceStatus",
    manualToggleId: "nutritionManualToggle",
    readyText: "Wger available. Logging through Wger flow.",
    fallbackText: "Wger unavailable. Manual nutrition logger enabled as fallback.",
  });
}

function setupScrollReveal() {
  const revealNodes = [
    ...document.querySelectorAll("header"),
    ...document.querySelectorAll(".card"),
  ];
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
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -30px 0px" }
  );

  revealNodes.forEach((node) => observer.observe(node));
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
  } catch {
    // Ignore service worker registration errors in local file contexts
  }
}

function initUI() {
  setupThemeToggle();
  setupMissionBoard();
  setupLeaderboardRefresh();
  setupWorkoutShortcuts();
  setupShareActions();
  setupNotifications();
  setupManualToggles();
  setupWgerFilters();
  setupWgerPrimaryLoggers();
  setupWgerFeeds();
  setupScrollReveal();
  registerServiceWorker();
}

initUI();

const profile = document.getElementById("profile");
const login = document.getElementById("login");

async function loginpage() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: "http://127.0.0.1:5500/",
    },
  });

  if (data.url) {
    window.location.href = data.url;
  }
}
window.loginpage = loginpage;

const {
  data: { session },
} = await supabase.auth.getSession();

if (session && profile && login) {
  profile.classList.remove("hidden");
  login.classList.add("hidden");
  document.getElementById("profile-pic").src =
    session.user.user_metadata.avatar_url;
  document.getElementById("username").textContent =
    "Welcome, " + session.user.user_metadata.full_name + "!";
} else if (profile && login) {
  login.classList.remove("hidden");
  profile.classList.add("hidden");
}

const logoutBtn = document.getElementById("logout");

logoutBtn?.addEventListener("click", async () => {
  const { error } = await supabase.auth.signOut();

  if (error) {
    console.error("Logout error:", error.message);
  } else {
    alert("You have been logged out!");
    window.location.reload();
  }
});
