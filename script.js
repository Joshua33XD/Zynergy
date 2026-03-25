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
const workoutBuilderState = { sets: [] };
const gamificationState = {
  dailyMissions: [],
  completedMissionKeys: new Set(),
  badges: [],
  leaderboardLastRank: null,
};

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

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function roundTo(value, digits = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

function getWorkoutPresetStorageKey() {
  return "lastWorkoutPreset";
}

function buildWorkoutSet(values = {}) {
  return {
    reps: clampNumber(values.reps ?? 10, 1, 100),
    weight: clampNumber(values.weight ?? 40, 0, 1000),
  };
}

function syncWorkoutSetCounter() {
  const setCount = workoutBuilderState.sets.length;
  uiState.setCount = setCount;
  const counter = document.getElementById("setCounter");
  if (counter) counter.textContent = `Sets planned: ${setCount}`;
  const setCountInput = document.getElementById("wgerSets");
  if (setCountInput) setCountInput.value = String(setCount || 1);
}

function renderWorkoutSetRows() {
  const listEl = document.getElementById("workoutSetList");
  if (!listEl) return;

  listEl.replaceChildren();
  workoutBuilderState.sets.forEach((setRow, index) => {
    const row = document.createElement("div");
    row.className = "workout-set-row";
    row.innerHTML = `
      <div class="workout-set-label">Set ${index + 1}</div>
      <label class="form-row">
        <span>Reps</span>
        <input type="number" min="1" max="100" step="1" data-role="set-reps" value="${setRow.reps}">
      </label>
      <label class="form-row">
        <span>Weight (kg)</span>
        <input type="number" min="0" max="1000" step="0.5" data-role="set-weight" value="${setRow.weight}">
      </label>
      <button type="button" class="workout-set-remove" data-role="remove-set" aria-label="Remove set ${index + 1}">Remove</button>
    `;

    const repsInput = row.querySelector('[data-role="set-reps"]');
    const weightInput = row.querySelector('[data-role="set-weight"]');
    const removeBtn = row.querySelector('[data-role="remove-set"]');

    repsInput?.addEventListener("input", () => {
      workoutBuilderState.sets[index].reps = clampNumber(repsInput.value, 1, 100);
    });
    weightInput?.addEventListener("input", () => {
      workoutBuilderState.sets[index].weight = clampNumber(weightInput.value, 0, 1000);
    });
    removeBtn?.addEventListener("click", () => {
      if (workoutBuilderState.sets.length <= 1) return;
      workoutBuilderState.sets.splice(index, 1);
      renderWorkoutSetRows();
      syncWorkoutSetCounter();
    });

    listEl.appendChild(row);
  });

  syncWorkoutSetCounter();
}

function ensureWorkoutSetCount(targetCount, { preserveExisting = true } = {}) {
  const count = clampNumber(targetCount, 1, 12);
  const next = preserveExisting ? [...workoutBuilderState.sets] : [];

  while (next.length < count) {
    const previous = next[next.length - 1];
    next.push(buildWorkoutSet(previous || {}));
  }
  next.length = count;
  workoutBuilderState.sets = next.map((item) => buildWorkoutSet(item));
  renderWorkoutSetRows();
}

function getWorkoutSetSummary() {
  const validSets = workoutBuilderState.sets
    .map((setRow) => ({
      reps: clampNumber(setRow.reps, 1, 100),
      weight: clampNumber(setRow.weight, 0, 1000),
    }))
    .filter((setRow) => setRow.reps > 0);

  return {
    sets: validSets,
    topWeight: validSets.reduce((max, setRow) => Math.max(max, setRow.weight), 0),
    totalVolume: roundTo(
      validSets.reduce((sum, setRow) => sum + setRow.reps * setRow.weight, 0),
      1
    ),
    description: validSets
      .map((setRow, index) => `S${index + 1} ${setRow.reps}x${setRow.weight}kg`)
      .join(" | "),
  };
}

function getSleepMoodScore(emojiValue) {
  const scoreMap = {
    emoji1: 40,
    emoji2: 88,
    emoji3: 56,
    emoji4: 32,
    emoji5: 96,
    "😴🛌💤": 40,
    "😃☀️🌞": 88,
    "😬☕🥱": 56,
    "😡⏰😒": 32,
    "🏃‍♂️💨⏱️": 96,
  };
  return scoreMap[emojiValue] ?? 60;
}

function getSleepRecoverySnapshot(hoursSlept, emojiValue) {
  const sleepBankPct = clampNumber(Math.round((Number(hoursSlept || 0) / 8) * 100), 0, 100);
  const morningPct = clampNumber(Math.round(getSleepMoodScore(emojiValue)), 0, 100);
  const stressPct = clampNumber(
    Math.round(100 - (sleepBankPct * 0.55 + morningPct * 0.45)),
    0,
    100
  );
  const tier =
    sleepBankPct >= 85 && morningPct >= 80 ? "Elite" :
    sleepBankPct >= 70 ? "Stable" :
    sleepBankPct >= 50 ? "Recovering" :
    "Needs work";
  return { sleepBankPct, morningPct, stressPct, tier };
}

function applySleepRecoveryUi(snapshot, extras = {}) {
  if (!snapshot) return;
  const { sleepBankPct, morningPct, stressPct, tier } = snapshot;

  animateMeterById("sleepMeter", sleepBankPct);
  animateMeterById("morningMeter", morningPct);
  animateMeterById("stressMeter", stressPct);
  animateMeterById("dashboardSleepQualityMeter", sleepBankPct);
  animateMeterById("dashboardHydrationMeter", clampNumber(extras.hydrationPct ?? 0, 0, 100));

  const mappings = [
    ["sleepBankLabel", `${sleepBankPct}%`],
    ["morningLabel", `${morningPct}%`],
    ["stressLabel", `${stressPct}%`],
    ["sleepRecoveryTierLabel", tier],
    ["dashboardSleepQualityLabel", `${sleepBankPct}%`],
    ["dashboardHydrationLabel", `${clampNumber(extras.hydrationPct ?? 0, 0, 100)}%`],
  ];
  mappings.forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  });

  const avgSleepEl = document.getElementById("sleepAvgLabel");
  if (avgSleepEl && extras.avgSleepHours != null) {
    avgSleepEl.textContent = `${roundTo(extras.avgSleepHours, 1)} h`;
  }
  const lateNightsEl = document.getElementById("sleepLateNightsLabel");
  if (lateNightsEl && extras.lateNights != null) {
    lateNightsEl.textContent = String(extras.lateNights);
  }
}

function scaleAiNutrition(per100g, grams) {
  if (!per100g) return null;
  const factor = Math.max(0, Number(grams) || 0) / 100;
  return {
    calories: roundTo((per100g.calories || 0) * factor, 1),
    protein_g: roundTo((per100g.protein_g || 0) * factor, 1),
    carbs_g: roundTo((per100g.carbs_g || 0) * factor, 1),
    fat_g: roundTo((per100g.fat_g || 0) * factor, 1),
  };
}

function normalizeAiDetection(item, index) {
  const defaultGrams = Math.max(
    30,
    Math.min(600, roundTo(item?.grams ?? item?.default_grams ?? 150, 0))
  );
  const nutritionPer100g = item?.nutrition_per_100g || null;
  return {
    id: item?.id || `ai-food-${index + 1}`,
    label: item?.label || `Food ${index + 1}`,
    confidence: Number(item?.confidence) || null,
    candidates: Array.isArray(item?.candidates) ? item.candidates : [],
    bbox: item?.bbox || null,
    defaultGrams,
    grams: defaultGrams,
    enabled: true,
    nutrition_source: item?.nutrition_source || null,
    nutrition_meta: item?.nutrition_meta || null,
    nutrition_per_100g: nutritionPer100g,
    nutrition: scaleAiNutrition(nutritionPer100g, defaultGrams),
  };
}

function getActiveAiDetections() {
  return aiMealScanState.detections.filter((item) => item.enabled);
}

function getAiTotals() {
  const totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  getActiveAiDetections().forEach((item) => {
    if (!item.nutrition) return;
    totals.calories += Number(item.nutrition.calories) || 0;
    totals.protein_g += Number(item.nutrition.protein_g) || 0;
    totals.carbs_g += Number(item.nutrition.carbs_g) || 0;
    totals.fat_g += Number(item.nutrition.fat_g) || 0;
  });
  return {
    calories: roundTo(totals.calories, 1),
    protein_g: roundTo(totals.protein_g, 1),
    carbs_g: roundTo(totals.carbs_g, 1),
    fat_g: roundTo(totals.fat_g, 1),
  };
}

function setAiStatus(message, type = "info") {
  const statusEl = document.getElementById("aiMealStatus");
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.style.color =
    type === "error" ? "#fca5a5" :
    type === "success" ? "#86efac" :
    "";
}

function updateAiSummary() {
  const totals = getAiTotals();
  const activeFoods = getActiveAiDetections().length;
  const foodsCountEl = document.getElementById("aiFoodsCount");
  const caloriesEl = document.getElementById("aiCaloriesTotal");
  const proteinEl = document.getElementById("aiProteinTotal");
  const carbsFatEl = document.getElementById("aiCarbsFatTotal");
  const applyBtn = document.getElementById("aiMealApplyBtn");

  if (foodsCountEl) foodsCountEl.textContent = String(activeFoods);
  if (caloriesEl) caloriesEl.textContent = `${roundTo(totals.calories, 0)} kcal`;
  if (proteinEl) proteinEl.textContent = `${totals.protein_g} g`;
  if (carbsFatEl) carbsFatEl.textContent = `${totals.carbs_g} g / ${totals.fat_g} g`;
  if (applyBtn) applyBtn.disabled = activeFoods === 0;
}

function renderAiDetectedFoods() {
  const listEl = document.getElementById("aiDetectedFoods");
  if (!listEl) return;

  listEl.replaceChildren();
  if (!aiMealScanState.detections.length) {
    const empty = document.createElement("div");
    empty.className = "ai-empty-state";
    empty.innerHTML = "<p class=\"muted\">No AI detections yet. Once your image is analyzed, each food gets its own editable portion slider here.</p>";
    listEl.appendChild(empty);
    updateAiSummary();
    return;
  }

  aiMealScanState.detections.forEach((item, index) => {
    const article = document.createElement("article");
    article.className = "ai-detected-item";

    const candidateHtml = (item.candidates || [])
      .slice(0, 4)
      .map((candidate) => {
        const confidenceText = candidate?.confidence
          ? ` ${Math.round(candidate.confidence * 100)}%`
          : "";
        return `<span class="ai-chip">${candidate?.label || "Candidate"}${confidenceText}</span>`;
      })
      .join("");

    article.innerHTML = `
      <div class="ai-item-head">
        <div>
          <h3>${item.label}</h3>
          <p class="muted">
            ${item.confidence ? `Detection confidence ${Math.round(item.confidence * 100)}%. ` : ""}
            ${item.nutrition_source ? `Nutrition fallback: ${item.nutrition_source.replaceAll("_", " ")}.` : "Nutrition fallback unavailable for this item."}
          </p>
        </div>
        <label class="ai-item-toggle">
          <input type="checkbox" data-role="enabled-toggle" checked>
          Include
        </label>
      </div>
      ${candidateHtml ? `<div class="ai-item-candidates">${candidateHtml}</div>` : ""}
      <div class="ai-portion-controls">
        <div class="ai-portion-topline">
          <span>Portion Size</span>
          <span data-role="portion-label">0 g</span>
        </div>
        <div class="ai-portion-inputs">
          <input type="range" min="30" max="600" step="5" data-role="grams-range">
          <input type="number" min="30" max="600" step="5" data-role="grams-input">
        </div>
      </div>
      <div class="ai-macro-grid">
        <div class="ai-macro-card">
          <span>Calories</span>
          <strong data-role="calories-value">0 kcal</strong>
        </div>
        <div class="ai-macro-card">
          <span>Protein</span>
          <strong data-role="protein-value">0 g</strong>
        </div>
        <div class="ai-macro-card">
          <span>Carbs</span>
          <strong data-role="carbs-value">0 g</strong>
        </div>
        <div class="ai-macro-card">
          <span>Fat</span>
          <strong data-role="fat-value">0 g</strong>
        </div>
      </div>
    `;

    const enabledToggle = article.querySelector('[data-role="enabled-toggle"]');
    const gramsRange = article.querySelector('[data-role="grams-range"]');
    const gramsInput = article.querySelector('[data-role="grams-input"]');
    const portionLabel = article.querySelector('[data-role="portion-label"]');
    const caloriesValue = article.querySelector('[data-role="calories-value"]');
    const proteinValue = article.querySelector('[data-role="protein-value"]');
    const carbsValue = article.querySelector('[data-role="carbs-value"]');
    const fatValue = article.querySelector('[data-role="fat-value"]');

    const paintCard = () => {
      article.style.opacity = item.enabled ? "1" : "0.55";
      article.style.filter = item.enabled ? "none" : "grayscale(0.2)";
      gramsRange.value = String(item.grams);
      gramsInput.value = String(item.grams);
      gramsRange.disabled = !item.enabled;
      gramsInput.disabled = !item.enabled;
      portionLabel.textContent = `${roundTo(item.grams, 0)} g`;

      if (item.nutrition) {
        caloriesValue.textContent = `${roundTo(item.nutrition.calories, 0)} kcal`;
        proteinValue.textContent = `${item.nutrition.protein_g} g`;
        carbsValue.textContent = `${item.nutrition.carbs_g} g`;
        fatValue.textContent = `${item.nutrition.fat_g} g`;
      } else {
        caloriesValue.textContent = "N/A";
        proteinValue.textContent = "N/A";
        carbsValue.textContent = "N/A";
        fatValue.textContent = "N/A";
      }
    };

    const updateGrams = (nextValue) => {
      const numeric = Math.max(30, Math.min(600, roundTo(nextValue || item.defaultGrams, 0)));
      item.grams = numeric;
      item.nutrition = scaleAiNutrition(item.nutrition_per_100g, numeric);
      paintCard();
      updateAiSummary();
    };

    enabledToggle?.addEventListener("change", () => {
      item.enabled = enabledToggle.checked;
      paintCard();
      updateAiSummary();
    });

    gramsRange?.addEventListener("input", () => updateGrams(Number(gramsRange.value)));
    gramsInput?.addEventListener("input", () => updateGrams(Number(gramsInput.value)));

    paintCard();
    listEl.appendChild(article);
  });

  updateAiSummary();
}

async function analyzeAiMealPhoto() {
  const fileInput = document.getElementById("aiMealPhoto");
  const file = fileInput?.files?.[0];
  if (!file) {
    setAiStatus("Choose a meal photo before running AI analysis.", "error");
    showToast("Please upload a meal photo first.", "error");
    return;
  }

  setButtonBusy("aiMealAnalyzeBtn", true, "Analyze Meal Photo");
  setAiStatus("Analyzing your meal photo with LogMeal and nutrition fallbacks...");

  const formData = new FormData();
  formData.append("image", file);

  try {
    const response = await fetch(`${FOOD_AI_API_BASE}/api/food/analyze`, {
      method: "POST",
      body: formData,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || "Meal analysis failed.");
    }

    aiMealScanState.imageId = payload?.image_id || null;
    aiMealScanState.detections = Array.isArray(payload?.detections)
      ? payload.detections.map(normalizeAiDetection)
      : [];

    renderAiDetectedFoods();

    if (!aiMealScanState.detections.length) {
      setAiStatus("The image uploaded successfully, but no foods were detected. Try a clearer top-down meal photo.", "error");
      return;
    }

    const warningText = Array.isArray(payload?.warnings) && payload.warnings.length
      ? ` ${payload.warnings[0]}`
      : "";
    setAiStatus(
      `Detected ${aiMealScanState.detections.length} food item(s). Adjust the sliders, then apply the result to your logger.${warningText}`,
      "success"
    );
    showToast("Meal analysis completed.", "success");
  } catch (error) {
    aiMealScanState.imageId = null;
    aiMealScanState.detections = [];
    renderAiDetectedFoods();
    setAiStatus(error.message || "Meal analysis failed.", "error");
    showToast(error.message || "Meal analysis failed.", "error");
  } finally {
    setButtonBusy("aiMealAnalyzeBtn", false, "Analyze Meal Photo");
  }
}

function applyAiMealToLogger() {
  const detections = getActiveAiDetections();
  if (!detections.length) {
    setAiStatus("Include at least one detected food before applying the scan.", "error");
    showToast("No detected foods are selected.", "error");
    return;
  }

  const mealType = document.getElementById("aiMealType")?.value || "lunch";
  const mealSummary = detections
    .map((item) => `${item.label} (${roundTo(item.grams, 0)}g)`)
    .join(", ");
  const totals = getAiTotals();
  const totalGrams = roundTo(
    detections.reduce((sum, item) => sum + (Number(item.grams) || 0), 0),
    0
  );
  const nutritionSources = [...new Set(
    detections
      .map((item) => item.nutrition_source)
      .filter(Boolean)
      .map((source) => source.replaceAll("_", " "))
  )];

  const manualCard = document.getElementById("manualNutritionCard");
  if (manualCard) manualCard.classList.remove("hidden");
  const manualToggle = document.getElementById("nutritionManualToggle");
  if (manualToggle) manualToggle.textContent = "Hide Manual Logger";

  const manualField = document.getElementById(mealType);
  if (manualField) manualField.value = mealSummary;

  const notesEl = document.getElementById("notes");
  const noteFragments = [
    `AI meal scan: ${mealSummary}`,
    `AI totals: ${roundTo(totals.calories, 0)} kcal, ${totals.protein_g}g protein, ${totals.carbs_g}g carbs, ${totals.fat_g}g fat`,
    nutritionSources.length ? `Nutrition sources: ${nutritionSources.join(", ")}` : null,
  ].filter(Boolean);
  if (notesEl) {
    const existing = notesEl.value.trim();
    const nextNotes = noteFragments.join(" | ");
    notesEl.value = existing ? `${existing} | ${nextNotes}` : nextNotes;
  }

  const wgerSearch = document.getElementById("wgerIngredientSearch");
  if (wgerSearch) wgerSearch.value = detections[0].label;
  const wgerMealType = document.getElementById("wgerMealType");
  if (wgerMealType) wgerMealType.value = mealType;
  const wgerGrams = document.getElementById("wgerGrams");
  if (wgerGrams) wgerGrams.value = String(totalGrams);

  setAiStatus("AI meal scan applied to the logger. Review the fields and save when ready.", "success");
  showToast("AI meal scan applied to the logger.", "success");
}

function setupAiMealScan() {
  const fileInput = document.getElementById("aiMealPhoto");
  const previewWrap = document.getElementById("aiMealPhotoPreviewWrap");
  const previewImg = document.getElementById("aiMealPhotoPreview");
  const analyzeBtn = document.getElementById("aiMealAnalyzeBtn");
  const applyBtn = document.getElementById("aiMealApplyBtn");

  if (!fileInput || !previewWrap || !previewImg || !analyzeBtn || !applyBtn) return;

  fileInput.addEventListener("change", () => {
    if (aiMealScanState.photoObjectUrl) {
      URL.revokeObjectURL(aiMealScanState.photoObjectUrl);
      aiMealScanState.photoObjectUrl = null;
    }

    const file = fileInput.files?.[0];
    aiMealScanState.imageId = null;
    aiMealScanState.detections = [];
    renderAiDetectedFoods();

    if (!file) {
      previewImg.removeAttribute("src");
      previewWrap.classList.add("hidden");
      setAiStatus("Upload a meal photo to start AI analysis.");
      return;
    }

    aiMealScanState.photoObjectUrl = URL.createObjectURL(file);
    previewImg.src = aiMealScanState.photoObjectUrl;
    previewWrap.classList.remove("hidden");
    setAiStatus("Photo ready. Run analysis to detect foods and estimate nutrition.");
  });

  analyzeBtn.addEventListener("click", analyzeAiMealPhoto);
  applyBtn.addEventListener("click", applyAiMealToLogger);
  renderAiDetectedFoods();
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

function getMissionSelectionStorageKey() {
  return `zynergy_daily_mission_selection_${new Date().toISOString().split("T")[0]}`;
}

function loadSelectedMissionKeys() {
  const raw = localStorage.getItem(getMissionSelectionStorageKey());
  if (!raw) return getDailyMissionCatalog().map((mission) => mission.key);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length
      ? parsed.filter(Boolean)
      : getDailyMissionCatalog().map((mission) => mission.key);
  } catch {
    return getDailyMissionCatalog().map((mission) => mission.key);
  }
}

function saveSelectedMissionKeys(keys) {
  localStorage.setItem(getMissionSelectionStorageKey(), JSON.stringify(Array.from(new Set(keys))));
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

async function syncMissionProgressFromActivity() {
  const selectedKeys = loadSelectedMissionKeys();
  gamificationState.dailyMissions = getDailyMissionCatalog().filter((mission) =>
    selectedKeys.includes(mission.key)
  );

  const nextCompleted = new Set();
  const stored = loadMissionProgress();
  if (stored.has("post_challenge")) nextCompleted.add("post_challenge");
  if (stored.has("__daily_bonus__")) nextCompleted.add("__daily_bonus__");

  const userInfo = await getUserInfo();
  if (userInfo) {
    const today = toLocalDateString(new Date());
    const { user_id } = userInfo;
    const [{ data: workouts }, { data: nutrition }, { data: sleep }] = await Promise.all([
      supabase.from("workout_daily").select("date").eq("user_id", user_id).eq("date", today).limit(1),
      supabase.from("daily_nutrition").select("entry_date").eq("user_id", user_id).eq("entry_date", today).limit(1),
      supabase.from("daily_sleep").select('"Date"').eq("user_id", user_id).eq("Date", today).limit(1),
    ]);

    if ((workouts || []).length) nextCompleted.add("log_workout");
    if ((nutrition || []).length) nextCompleted.add("log_nutrition");
    if ((sleep || []).length) nextCompleted.add("log_sleep");
  }

  gamificationState.completedMissionKeys = nextCompleted;
  saveMissionProgress(nextCompleted);
  renderMissionBoard();
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
  if (!gamificationState.dailyMissions.length) {
    const empty = document.createElement("li");
    empty.innerHTML = "<span>No missions selected yet.</span><button class=\"mission-toggle\" type=\"button\" disabled>Plan first</button>";
    missionList.appendChild(empty);
    const missionPct = document.getElementById("missionPct");
    if (missionPct) missionPct.textContent = "0%";
    animateMeterById("missionMeter", 0);
    const bonusLabel = document.getElementById("missionBonusLabel");
    if (bonusLabel) bonusLabel.textContent = "Choose today's missions to enable auto-tracking.";
    return;
  }

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
    btn.textContent = done ? "Done" : "Auto";
    btn.disabled = true;
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

const FOOD_AI_API_BASE = window.FOOD_AI_API_BASE_URL || "http://127.0.0.1:8000";
const aiMealScanState = {
  photoObjectUrl: null,
  detections: [],
  imageId: null,
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
      right: "20px",
      bottom: "20px",
      display: "grid",
      gap: "10px",
      zIndex: "9999",
      pointerEvents: "none",
      width: "min(320px, calc(100vw - 32px))",
    });
    document.body.appendChild(container);
  }

  const palette = {
    info: { bg: "#183b5b", border: "#3b82f6" },
    success: { bg: "#163824", border: "#22c55e" },
    error: { bg: "#4c1d1d", border: "#ef4444" },
  };
  const colors = palette[type] || palette.info;
  const toast = document.createElement("div");
  Object.assign(toast.style, {
    background: colors.bg,
    border: `1px solid ${colors.border}`,
    color: "#f8fafc",
    borderRadius: "14px",
    boxShadow: "0 10px 30px rgba(0,0,0,0.24)",
    padding: "12px 14px",
    fontSize: "0.95rem",
    lineHeight: "1.4",
    opacity: "0",
    transform: "translateY(8px)",
    transition: "opacity 0.2s ease, transform 0.2s ease",
  });
  toast.textContent = message;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";
  });

  window.setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
    window.setTimeout(() => toast.remove(), 220);
  }, 2800);
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

function capitalizeFirst(text) {
  if (!text) return "";
  return text[0].toUpperCase() + text.slice(1).toLowerCase();
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
// Uses LOCAL_EXERCISES with keyword + muscle-group filters. No external API.
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

  if (statusEl) statusEl.textContent = "Searching local exercise library...";
  fillWgerExerciseSelect([]);

  // Filter local exercises by name + optional muscle group
  const lower = query.toLowerCase();
  let exercises = LOCAL_EXERCISES.filter((ex) =>
    ex.name.toLowerCase().includes(lower)
  );

  const muscleId = muscleSelect?.value;
  if (muscleId) {
    exercises = exercises.filter((ex) => ex.muscle === muscleId);
  }

  wgerState.exercises = exercises;
  fillWgerExerciseSelect(exercises);

  // Render cards with a simple visual thumbnail
  if (listEl) {
    listEl.replaceChildren();
    exercises.slice(0, 20).forEach((ex) => {
      const card = document.createElement("article");
      card.className = "api-item";

      const thumb = document.createElement("div");
      thumb.className = "exercise-thumb";
      thumb.textContent = (ex.name || "?").charAt(0).toUpperCase();

      const title = document.createElement("h3");
      title.textContent = ex.name;
      const desc = document.createElement("p");
      desc.textContent = ex.description || "No description available.";

      card.append(thumb, title, desc);
      listEl.appendChild(card);
    });
  }

  if (statusEl) {
    statusEl.textContent = exercises.length
      ? `Found ${exercises.length} exercise(s) for "${query}".`
      : `No exercises found for "${query}". Try a different keyword.`;
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

  const workoutStatus = document.getElementById("workoutSourceStatus");
  if (workoutStatus) {
    workoutStatus.textContent = wgerReady
      ? "Local exercise library ready. Search for an exercise to begin."
      : "Exercise library unavailable.";
  }

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
  const workoutSets = getWorkoutSetSummary();

  if (!exerciseSelect?.value || exerciseSelect.value === "") {
    if (statusLabel) statusLabel.textContent = "Select an exercise result before saving.";
    setButtonBusy("wgerWorkoutSaveBtn", false, "Log Selected Workout");
    showToast("Please search for and select an exercise first.", "error");
    return;
  }
  if (!workoutSets.sets.length) {
    if (statusLabel) statusLabel.textContent = "Add at least one set before saving.";
    setButtonBusy("wgerWorkoutSaveBtn", false, "Log Selected Workout");
    showToast("Please add at least one set before saving.", "error");
    return;
  }
  if (workoutSets.sets.some((setRow) => setRow.weight <= 0)) {
    if (statusLabel) statusLabel.textContent = "Each set needs a weight greater than 0kg.";
    setButtonBusy("wgerWorkoutSaveBtn", false, "Log Selected Workout");
    showToast("Each set needs a weight greater than 0 kg.", "error");
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
      workout_status: `${exerciseName}: ${workoutSets.description} | Volume ${workoutSets.totalVolume} kg-reps`,
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
  maybeNotify("Workout saved", `${exerciseName} saved through the local library.`);
  showToast("Workout saved successfully.", "success");

  const challengeInput = document.getElementById("challengeExercise");
  if (challengeInput && !challengeInput.value) {
    challengeInput.value = exerciseName;
  }
  const challengeWeight = document.getElementById("challengeWeight");
  if (challengeWeight) challengeWeight.value = String(workoutSets.topWeight);
  const challengeReps = document.getElementById("challengeReps");
  if (challengeReps && workoutSets.sets[0]) {
    challengeReps.value = String(workoutSets.sets[0].reps);
  }

  localStorage.setItem(
    getWorkoutPresetStorageKey(),
    JSON.stringify({
      intensity: intensityRaw,
      muscleFocus,
      exerciseSearch: document.getElementById("wgerExerciseSearch")?.value || "",
      exerciseId: exerciseSelect.value,
      exerciseName,
      sets: workoutSets.sets,
    })
  );

  addXp(30);
  markMissionComplete("log_workout");
  if (statusLabel) statusLabel.textContent = "Workout saved to your daily log.";
  loadSidebarProfileStats();
  loadDashboardOverview();
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
  showToast("Nutrition data saved successfully via Wger.", "success");
  addXp(15);
  markMissionComplete("log_nutrition");
  if (statusLabel) statusLabel.textContent = "Nutrition saved to your daily log.";
  loadDashboardOverview();
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
  return saveWorkoutViaWger();
}

function renderMissionPlanner() {
  const planner = document.getElementById("missionPlannerList");
  if (!planner) return;
  const selected = new Set(loadSelectedMissionKeys());
  planner.replaceChildren();

  getDailyMissionCatalog().forEach((mission) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = mission.key;
    input.checked = selected.has(mission.key);
    const text = document.createElement("span");
    text.textContent = `${mission.label} (+${mission.xp} XP)`;
    label.append(input, text);
    planner.appendChild(label);
  });
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
    showToast("Hours slept must be between 0 and 12.", "error");
    return;
  }
  const validEmojis = Object.values(emojiMap);
  if (!validEmojis.includes(sleep_emoji)) {
    if (statusEl) statusEl.textContent = "Invalid wake-up feeling selected.";
    showToast("Invalid sleep emoji.", "error");
    return;
  }
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
    const snapshot = getSleepRecoverySnapshot(hours_slept, emojiRaw);
    showXpPop("+10 XP");
    applySleepRecoveryUi(snapshot);
    maybeNotify("Sleep log saved", `Recovery updated: ${hours_slept}h`);
    showToast("Sleep data saved successfully!", "success");
    addXp(10, "sleep_log");
    markMissionComplete("log_sleep");
    if (statusEl) statusEl.textContent = "Sleep log saved/updated for today.";
    loadSleepOverview();
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
  if (!breakfast || !lunch || !dinner || !snacks) {
    if (nutritionSaveStatus) nutritionSaveStatus.textContent = "Please fill in all meal fields.";
    showToast("Please fill in all meal fields.", "error");
    return;
  }
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
  if (error) {
    if (nutritionSaveStatus) nutritionSaveStatus.textContent = "Nutrition save failed. Try again.";
    showToast(handleError(error, "daily_nutrition", user_id, entry_date), "error");
  }
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
    loadDashboardOverview();
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
    if (statusEl) statusEl.textContent = "Enter an exercise name to post a challenge.";
    showToast("Please enter an exercise name for the challenge.", "error");
    return;
  }
  if (reps <= 0 || weight <= 0) {
    if (statusEl) statusEl.textContent = "Reps and weight must both be greater than 0.";
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
  loadDashboardOverview();
  loadSidebarProfileStats();
}

async function loadLeaderboard() {
  const list = document.getElementById("leaderboardList");
  if (!list) return;

  list.replaceChildren();

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

  const userInfo = await getUserInfo();
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
  const workoutSaveBtn = document.getElementById("wgerWorkoutSaveBtn");
  if (!workoutSaveBtn) return;
  const addSetBtn = document.getElementById("addSetBtn");
  const repeatWorkoutBtn = document.getElementById("repeatWorkoutBtn");
  const setCountInput = document.getElementById("wgerSets");
  const intensity = document.getElementById("wgerWorkoutIntensity");
  const muscleFocus = document.getElementById("wgerMuscleFocus");
  const exerciseSearch = document.getElementById("wgerExerciseSearch");
  const exerciseSelect = document.getElementById("wgerExerciseSelect");

  ensureWorkoutSetCount(Number(setCountInput?.value || 3), { preserveExisting: false });

  const addSet = () => {
    ensureWorkoutSetCount(workoutBuilderState.sets.length + 1);
    showXpPop("Set added");
  };

  addSetBtn?.addEventListener("click", addSet);
  setCountInput?.addEventListener("input", () => {
    ensureWorkoutSetCount(Number(setCountInput.value || 1));
  });
  repeatWorkoutBtn?.addEventListener("click", () => {
    const cached = localStorage.getItem(getWorkoutPresetStorageKey());
    if (!cached) return;
    try {
      const value = JSON.parse(cached);
      if (intensity && value.intensity) intensity.value = value.intensity;
      if (muscleFocus && value.muscleFocus) muscleFocus.value = value.muscleFocus;
      if (exerciseSearch && value.exerciseSearch) exerciseSearch.value = value.exerciseSearch;
      if (exerciseSelect && value.exerciseId) {
        const existingOption = [...exerciseSelect.options].find((option) => option.value === value.exerciseId);
        if (!existingOption && value.exerciseName) {
          const opt = document.createElement("option");
          opt.value = value.exerciseId;
          opt.textContent = value.exerciseName;
          exerciseSelect.appendChild(opt);
        }
        exerciseSelect.value = value.exerciseId;
      }
      if (Array.isArray(value.sets) && value.sets.length) {
        workoutBuilderState.sets = value.sets.map((setRow) => buildWorkoutSet(setRow));
        renderWorkoutSetRows();
      }
      showXpPop("Preset loaded");
    } catch { /* ignore */ }
  });
  document.addEventListener("keydown", (event) => {
    const activeTag = document.activeElement?.tagName;
    const typing = activeTag === "INPUT" || activeTag === "TEXTAREA";
    if (event.code === "Space" && !typing) { event.preventDefault(); addSet(); }
    if (event.key === "Enter" && !typing) { event.preventDefault(); workoutSaveBtn.click(); }
    if ((event.key === "r" || event.key === "R") && !typing) { event.preventDefault(); repeatWorkoutBtn?.click(); }
  });
}

function setupShareActions() {
  document.getElementById("copyShareBtn")?.addEventListener("click", async () => {
    const text = "NEW PR: Deadlift 140kg. Level Up -> 15";
    try { await navigator.clipboard.writeText(text); showXpPop("Copied"); }
    catch { showToast("Copy failed. PR text: " + text, "error"); }
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

function ensureGlobalThemeButton() {
  let floatingBtn = document.getElementById("globalThemeToggleBtn");
  if (floatingBtn) return floatingBtn;

  floatingBtn = document.createElement("button");
  floatingBtn.id = "globalThemeToggleBtn";
  floatingBtn.type = "button";
  floatingBtn.className = "theme-fab";
  floatingBtn.setAttribute("data-theme-toggle", "global");
  floatingBtn.setAttribute("aria-label", "Toggle theme");
  document.body.appendChild(floatingBtn);
  return floatingBtn;
}

function setupThemeToggle() {
  const themeBtn = document.getElementById("themeToggleBtn");
  const floatingBtn = ensureGlobalThemeButton();
  const themeButtons = [themeBtn, floatingBtn].filter(Boolean);
  const rawTheme = localStorage.getItem("zynergyTheme") || "default";
  const savedTheme = rawTheme === "ion" ? "ion" : "default";
  const labelMap = { default: "Theme: Black", ion: "Theme: Blue" };
  const applyThemeUi = (themeName) => {
    applyTheme(themeName);
    themeButtons.forEach((button) => {
      button.textContent = labelMap[themeName] || labelMap.default;
      button.dataset.theme = themeName;
    });
  };

  applyThemeUi(savedTheme);
  if (!themeButtons.length) return;

  const handleToggle = () => {
    const current = document.body.getAttribute("data-theme") || "default";
    const next = current === "default" ? "ion" : "default";
    localStorage.setItem("zynergyTheme", next);
    applyThemeUi(next);
    showXpPop("Theme switched");
  };

  themeButtons.forEach((button) => {
    button.addEventListener("click", handleToggle);
  });
}

function setupMissionPlanner() {
  const planner = document.getElementById("missionPlannerList");
  const saveBtn = document.getElementById("missionPlannerSaveBtn");
  const statusEl = document.getElementById("missionPlannerStatus");
  if (!planner || !saveBtn) return;

  renderMissionPlanner();
  saveBtn.addEventListener("click", async () => {
    const selectedKeys = [...planner.querySelectorAll('input[type="checkbox"]:checked')]
      .map((input) => input.value)
      .filter(Boolean);

    if (!selectedKeys.length) {
      if (statusEl) statusEl.textContent = "Pick at least one mission for today.";
      showToast("Pick at least one mission for today.", "error");
      return;
    }

    saveSelectedMissionKeys(selectedKeys);
    if (statusEl) statusEl.textContent = "Today's mission plan saved. Progress will update automatically.";
    await syncMissionProgressFromActivity();
    showToast("Today's missions saved.", "success");
  });
}

async function setupMissionBoard() {
  if (!document.getElementById("missionList")) return;
  renderMissionPlanner();
  await syncMissionProgressFromActivity();
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

function getLevelProgress(xp) {
  const thresholds = [
    { level: 1, name: "Rookie", min: 0 },
    { level: 5, name: "Grind Starter", min: 250 },
    { level: 10, name: "Iron Disciple", min: 750 },
    { level: 15, name: "Plate Stacker", min: 1500 },
    { level: 20, name: "Volume Slayer", min: 2500 },
  ];
  const current = getLevelFromXp(xp);
  const currentIndex = thresholds.findIndex((item) => item.level === current.level);
  const next = thresholds[currentIndex + 1] || null;
  if (!next) {
    return { pct: 100, label: `${xp} XP total` };
  }
  const span = Math.max(1, next.min - current.min);
  const pct = Math.round(((xp - current.min) / span) * 100);
  return {
    pct: clampNumber(pct, 0, 100),
    label: `${xp} / ${next.min} XP to ${next.name}`,
  };
}

async function loadSidebarProfileStats() {
  const userInfo = await getUserInfo();
  if (!userInfo) return;

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

  const profile = await getOrCreateUserProfile();
  const xp = Number(profile?.xp || 0);
  const level = getLevelFromXp(xp);
  const levelLabel = document.getElementById("workoutLevelLabel");
  if (levelLabel) levelLabel.textContent = `${level.level} - ${level.name}`;
  const statusXpLabel = document.getElementById("statusXpLabel");
  if (statusXpLabel) statusXpLabel.textContent = String(xp);
}

async function loadSleepOverview() {
  if (!document.getElementById("sleepRecoveryTierLabel") && !document.getElementById("sleepBankLabel")) {
    return;
  }
  const userInfo = await getUserInfo();
  if (!userInfo) return;

  const { user_id } = userInfo;
  const today = toLocalDateString(new Date());
  const { data: sleepRows } = await supabase
    .from("daily_sleep")
    .select('"Date", hours_slept, sleep_emoji')
    .eq("user_id", user_id)
    .gte("Date", daysAgoLocal(13))
    .lte("Date", today)
    .order("Date", { ascending: false });

  if (!(sleepRows || []).length) return;

  const latest = sleepRows[0];
  const avgSleepHours =
    sleepRows.reduce((sum, row) => sum + Number(row.hours_slept || 0), 0) / sleepRows.length;
  const lateNights = sleepRows.filter((row) => Number(row.hours_slept || 0) < 6).length;
  const snapshot = getSleepRecoverySnapshot(latest.hours_slept, latest.sleep_emoji);
  applySleepRecoveryUi(snapshot, { avgSleepHours, lateNights });
}

async function loadDashboardOverview() {
  if (!document.getElementById("dashboardLevelLabel")) return;

  const userInfo = await getUserInfo();
  if (!userInfo) return;

  const { user_id, username } = userInfo;
  const today = toLocalDateString(new Date());
  const weekStart = daysAgoLocal(6);
  const streakStart = daysAgoLocal(45);
  const profile = await getOrCreateUserProfile();

  const [
    { data: workoutRows },
    { data: nutritionRows },
    { data: sleepRows },
    { data: leaderboardRows },
  ] = await Promise.all([
    supabase.from("workout_daily").select("date").eq("user_id", user_id).gte("date", streakStart).lte("date", today),
    supabase.from("daily_nutrition").select("entry_date, protein_goal_met, hydration_goal_met").eq("user_id", user_id).gte("entry_date", streakStart).lte("entry_date", today),
    supabase.from("daily_sleep").select('"Date", hours_slept, sleep_emoji').eq("user_id", user_id).gte("Date", streakStart).lte("Date", today),
    supabase.from("user_profile").select("user_id, xp").order("xp", { ascending: false }).limit(200),
  ]);

  const xp = Number(profile?.xp || 0);
  const level = getLevelFromXp(xp);
  const levelProgress = getLevelProgress(xp);
  const streak = computeDailyStreak([
    ...(workoutRows || []).map((row) => row.date),
    ...(nutritionRows || []).map((row) => row.entry_date),
    ...(sleepRows || []).map((row) => row.Date),
  ]);

  const rank =
    (leaderboardRows || []).findIndex((row) => row.user_id === user_id) >= 0
      ? (leaderboardRows || []).findIndex((row) => row.user_id === user_id) + 1
      : null;

  const weeklyNutrition = (nutritionRows || []).filter((row) => row.entry_date >= weekStart);
  const proteinAvg = weeklyNutrition.length
    ? Math.round(
        (weeklyNutrition.filter((row) => String(row.protein_goal_met).toLowerCase() === "yes").length /
          weeklyNutrition.length) *
          100
      )
    : 0;
  const hydrationPct = weeklyNutrition.length
    ? Math.round(
        (weeklyNutrition.filter((row) => String(row.hydration_goal_met).toLowerCase() === "yes").length /
          weeklyNutrition.length) *
          100
      )
    : 0;

  const recentSleep = (sleepRows || []).filter((row) => row.Date >= weekStart);
  const latestSleep = recentSleep[0] || sleepRows?.[0];
  const sleepSnapshot = latestSleep
    ? getSleepRecoverySnapshot(latestSleep.hours_slept, latestSleep.sleep_emoji)
    : null;

  const mappings = [
    ["dashboardLevelLabel", `${level.level} - ${level.name}`],
    ["dashboardRankLabel", rank ? `#${rank}` : "Unranked"],
    ["dashboardStreakLabel", streak ? `${streak} day(s)` : "Start today"],
    ["dashboardProteinAvgLabel", `${proteinAvg}%`],
    ["xpValue", String(xp)],
    ["xpMetaLabel", levelProgress.label],
    ["dashboardHeaderTitle", `${username}'s Dashboard`],
    ["dashboardHeaderSubtitle", "Live progress from your workout, nutrition, sleep, and challenge logs."],
  ];
  mappings.forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  });

  animateMeterById("xpMeter", levelProgress.pct);
  if (sleepSnapshot) {
    applySleepRecoveryUi(sleepSnapshot, { hydrationPct });
  } else {
    animateMeterById("dashboardHydrationMeter", hydrationPct);
    const hydrationLabel = document.getElementById("dashboardHydrationLabel");
    if (hydrationLabel) hydrationLabel.textContent = `${hydrationPct}%`;
  }
}

async function loadWeeklySummary() {
  const userInfo = await getUserInfo();
  if (!userInfo) return;
  const { user_id } = userInfo;
  const weekStart = daysAgoLocal(6);
  const today = toLocalDateString(new Date());

  const [{ data: workouts }, { data: nutrition }, { data: sleep }] = await Promise.all([
    supabase.from("workout_daily").select("date").eq("user_id", user_id).gte("date", weekStart).lte("date", today),
    supabase.from("daily_nutrition").select("entry_date").eq("user_id", user_id).gte("entry_date", weekStart).lte("entry_date", today),
    supabase.from("daily_sleep").select('"Date"').eq("user_id", user_id).gte("Date", weekStart).lte("Date", today),
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
  document.getElementById("nutritionManualToggle")?.addEventListener("click", () => {
    const card = document.getElementById("manualNutritionCard");
    if (!card) return;
    const showing = !card.classList.contains("hidden");
    card.classList.toggle("hidden", showing);
    document.getElementById("nutritionManualToggle").textContent = showing ? "Use Manual Logger" : "Hide Manual Logger";
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
  setupMissionPlanner();
  setupMissionBoard();
  setupLeaderboardRefresh();
  setupWorkoutShortcuts();
  setupShareActions();
  setupNotifications();
  setupManualToggles();
  setupMealCapture("wger");
  setupMealCapture("manual");
  setupAiMealScan();
  setupWgerFilters();
  setupWgerPrimaryLoggers();
  setupWgerFeeds();
  setupChallengeSection();
  setupHistoryPage();
  loadSidebarProfileStats();
  loadDashboardOverview();
  loadSleepOverview();
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
  else {
    showToast("You have been logged out!", "success");
    window.setTimeout(() => window.location.reload(), 1200);
  }
 });
