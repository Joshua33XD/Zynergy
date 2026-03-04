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

async function addXp(delta) {
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
  }
}

// ─── wger state ────────────────────────────────────────────────────────────────
// exercises and ingredients are now populated dynamically via live API search.
// We cache the last search results so the save buttons can look up details.
const wgerState = {
  exercises: [],       // last exercise search results
  ingredients: [],     // last ingredient search results
  muscleLookup: {},    // id → name, loaded once on init
  workoutReady: false,
  nutritionReady: false,
};

// ─── UI helpers ────────────────────────────────────────────────────────────────
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

// ─── SELECT FILLERS ────────────────────────────────────────────────────────────
function fillWgerExerciseSelect(exercises) {
  const select = document.getElementById("wgerExerciseSelect");
  if (!select) return;
  select.replaceChildren();

  if (!exercises.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No exercises found — try a different search";
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
    opt.textContent = "No ingredients found — try a different search";
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

// ─── EXERCISE SEARCH (fixed) ───────────────────────────────────────────────────
// Uses the wger /exercise/search/ endpoint for live keyword search, optionally
// filtered by muscle group from the pre-loaded muscle lookup.
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

  if (statusEl) statusEl.textContent = "Searching exercises…";
  fillWgerExerciseSelect([]);

  try {
    // FIX: Use the dedicated search endpoint with the term parameter
    const url = `https://wger.de/api/v2/exercise/search/?term=${encodeURIComponent(query)}&language=english&format=json`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();

    // The search endpoint returns { suggestions: [ { value, data: { id, ... } } ] }
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];

    // Map into our normalised shape
    let exercises = suggestions.map((s) => ({
      id: s.data?.id ?? s.data?.base_id,
      name: s.value || s.data?.name || "Unnamed exercise",
      description: stripHtml(s.data?.description || ""),
      muscleIds: [],   // search endpoint doesn't return muscle ids; filter below uses category
      category: s.data?.category || "",
    }));

    // Optional: client-side muscle filter using the wger category name
    const muscleId = muscleSelect?.value;
    if (muscleId && wgerState.muscleLookup[muscleId]) {
      const muscleName = wgerState.muscleLookup[muscleId].toLowerCase();
      exercises = exercises.filter(
        (ex) =>
          ex.name.toLowerCase().includes(muscleName) ||
          ex.category.toLowerCase().includes(muscleName)
      );
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
  } catch (err) {
    renderApiError(statusEl, listEl, "Could not search exercises. Check your connection.");
    console.error("Wger exercise search failed:", err);
    wgerState.exercises = [];
    fillWgerExerciseSelect([]);
  }
}

// ─── INGREDIENT SEARCH (fixed) ─────────────────────────────────────────────────
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

  if (statusEl) statusEl.textContent = "Searching ingredients…";
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

// ─── SORTING HELPER (replaces the broken getIngredientsByFocus) ─────────────
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

// ─── MUSCLE LOOKUP INIT ────────────────────────────────────────────────────────
// Load muscles once on startup — independent of exercise fetch so the dropdown
// is always available even if the exercise search hasn't run yet.
async function loadMuscleLookup() {
  try {
    const res = await fetch("https://wger.de/api/v2/muscle/?format=json&limit=100");
    if (!res.ok) return;
    const data = await res.json();
    const muscles = Array.isArray(data.results) ? data.results : [];
    wgerState.muscleLookup = muscles.reduce((acc, m) => {
      if (typeof m.id === "number" && (m.name_en || m.name)) {
        acc[m.id] = m.name_en || m.name;
      }
      return acc;
    }, {});
    fillWgerMuscleSelect(wgerState.muscleLookup);
  } catch (err) {
    console.error("Muscle lookup failed:", err);
  }
}

// ─── FILTER SETUP ──────────────────────────────────────────────────────────────
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

// ─── SOURCE MODE ───────────────────────────────────────────────────────────────
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

// ─── WGER FEEDS INIT ──────────────────────────────────────────────────────────
// FIX: We no longer bulk-fetch exercises/ingredients on startup.
// Instead we load muscles (lightweight) and mark wger as "ready" so the
// search-based UI is shown. Actual data loads only when the user searches.
async function setupWgerFeeds() {
  await loadMuscleLookup();

  // Wger is "ready" as long as the API is reachable (muscle fetch succeeded)
  const wgerReady = Object.keys(wgerState.muscleLookup).length > 0;

  wgerState.workoutReady = wgerReady;
  wgerState.nutritionReady = wgerReady;

  setSourceMode({
    ready: wgerReady,
    wgerCardId: "wgerWorkoutCard",
    manualCardId: "manualWorkoutCard",
    statusId: "workoutSourceStatus",
    manualToggleId: "workoutManualToggle",
    readyText: "Wger connected. Search for an exercise to begin.",
    fallbackText: "Wger unavailable. Manual workout logger enabled.",
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

// ─── SAVE VIA WGER ─────────────────────────────────────────────────────────────
async function saveWorkoutViaWger() {
  const userInfo = await getUserInfo();
  if (!userInfo) {
    alert("You must be logged in to save workouts.");
    return;
  }

  const muscleFocus = document.getElementById("wgerMuscleFocus")?.value || "";
  const exerciseSelect = document.getElementById("wgerExerciseSelect");
  const sets = Number(document.getElementById("wgerSets")?.value || 0);
  const reps = Number(document.getElementById("wgerReps")?.value || 0);
  const intensityRaw = document.getElementById("wgerWorkoutIntensity")?.value || "moderate";
  const weightKg = Number(document.getElementById("wgerWorkoutWeight")?.value || 0);

  if (!exerciseSelect?.value || exerciseSelect.value === "") {
    alert("Please search for and select an exercise first.");
    return;
  }
  if (weightKg <= 0) {
    alert("Please enter a top set weight greater than 0 kg.");
    return;
  }
  if (sets <= 0 || reps <= 0) {
    alert("Sets and reps must be greater than 0.");
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
    alert(handleError(error, "workout_daily", user_id, date));
    return;
  }

  uiState.sessionXp += 30;
  animateNumber("sessionXp", uiState.sessionXp);
  animateMeterById("sessionXpMeter", Math.min(100, uiState.sessionXp));
  showXpPop("+30 XP");
  maybeNotify("Workout saved", `${exerciseName} saved through Wger.`);
  alert("Workout saved successfully via Wger!");

  // Prefill challenge exercise name for quick posting
  const challengeInput = document.getElementById("challengeExercise");
  if (challengeInput && !challengeInput.value) {
    challengeInput.value = exerciseName;
  }

  addXp(30);
}

async function saveNutritionViaWger() {
  const userInfo = await getUserInfo();
  if (!userInfo) {
    alert("You must be logged in to save nutrition data.");
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
    alert("Please search for and select an ingredient first.");
    return;
  }
  if (grams <= 0) {
    alert("Amount must be greater than 0 grams.");
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
  addXp(15);
}

function setupWgerPrimaryLoggers() {
  document
    .getElementById("wgerWorkoutSaveBtn")
    ?.addEventListener("click", saveWorkoutViaWger);
  document
    .getElementById("wgerNutritionSaveBtn")
    ?.addEventListener("click", saveNutritionViaWger);
}

// ─── ALL OTHER UNCHANGED LOGIC ─────────────────────────────────────────────────
async function getValues() {
  const userInfo = await getUserInfo();
  if (!userInfo) {
    alert("You must be logged in to save workouts. Please log in first.");
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
    alert(handleError(error, "workout_daily", user_id, date));
  } else {
    uiState.sessionXp += 30;
    animateNumber("sessionXp", uiState.sessionXp);
    animateMeterById("sessionXpMeter", Math.min(100, uiState.sessionXp));
    showXpPop("+30 XP");
    maybeNotify("Workout saved", "Mission progress increased.");
    alert("Workout saved successfully!");
    addXp(30);
  }
}

async function saveSleepData() {
  const userInfo = await getUserInfo();
  if (!userInfo) { alert("You must be logged in to save sleep data."); return; }
  const { user_id, username } = userInfo;
  const hoursSleptRaw = document.getElementById("sleepInput")?.value;
  const emojiRaw = document.getElementById("emojiSelect")?.value;
  if (!hoursSleptRaw || !emojiRaw) { alert("Please fill in all sleep fields."); return; }
  const hours_slept = parseFloat(hoursSleptRaw);
  const date = new Date().toISOString().split("T")[0];
  const emojiMap = { emoji1: "😴🛌💤", emoji2: "😃☀️🌞", emoji3: "😬☕🥱", emoji4: "😡⏰😒", emoji5: "🏃‍♂️💨⏱️" };
  const sleep_emoji = emojiMap[emojiRaw] || emojiRaw;
  if (hours_slept < 0 || hours_slept > 12) { alert(`Hours slept must be between 0 and 12.`); return; }
  const validEmojis = ["😴🛌💤", "😃☀️🌞", "😬☕🥱", "😡⏰😒", "🏃‍♂️💨⏱️"];
  if (!validEmojis.includes(sleep_emoji)) { alert("Invalid sleep emoji."); return; }
  const { data, error } = await upsertWithFallback(
    "daily_sleep",
    { user_id, username, Date: date, hours_slept, sleep_emoji },
    'user_id,"Date"'
  );
  if (error) { alert(handleError(error, "daily_sleep", user_id, date)); }
  else {
    showXpPop("+10 XP");
    animateMeterById("sleepMeter", Math.min(100, hours_slept * 10));
    maybeNotify("Sleep log saved", `Recovery updated: ${hours_slept}h`);
    alert("Sleep data saved successfully!");
  }
}

async function saveNutritionData() {
  const userInfo = await getUserInfo();
  if (!userInfo) { alert("You must be logged in to save nutrition data."); return; }
  const { user_id, username } = userInfo;
  const breakfast = document.getElementById("breakfast")?.value?.trim() || "";
  const lunch = document.getElementById("lunch")?.value?.trim() || "";
  const dinner = document.getElementById("dinner")?.value?.trim() || "";
  const snacks = document.getElementById("snacks")?.value?.trim() || "";
  const hydration = document.getElementById("hydration")?.checked || false;
  const protein = document.getElementById("protein")?.checked || false;
  const balancedMeal = document.getElementById("balanced_meal")?.checked || false;
  const notes = document.getElementById("notes")?.value?.trim() || null;
  if (!breakfast || !lunch || !dinner || !snacks) { alert("Please fill in all meal fields."); return; }
  const entry_date = new Date().toISOString().split("T")[0];
  const { data, error } = await upsertWithFallback(
    "daily_nutrition",
    {
      user_id, username, entry_date, breakfast, lunch, dinner, snacks,
      hydration_goal_met: hydration ? "Yes" : "No",
      protein_goal_met: protein ? "Yes" : "No",
      balanced_meal_goal_met: balancedMeal ? "Yes" : "No",
      notes_or_regrets: notes,
    },
    "user_id,entry_date"
  );
  if (error) { alert(handleError(error, "daily_nutrition", user_id, entry_date)); }
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
    alert("Nutrition data saved successfully!");
  }
}

window.getValues = getValues;
window.saveSleepData = saveSleepData;
window.saveNutritionData = saveNutritionData;

// ─── WORKOUT CHALLENGES & LEADERBOARD ──────────────────────────────────────────
async function submitChallenge() {
  const userInfo = await getUserInfo();
  if (!userInfo) {
    alert("You must be logged in to post a challenge.");
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
    alert("Please enter an exercise name for the challenge.");
    return;
  }
  if (reps <= 0 || weight <= 0) {
    alert("Reps and weight must be greater than 0.");
    return;
  }

  const score = reps * weight;

  if (statusEl) statusEl.textContent = "Saving challenge…";

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
    alert("Challenge save failed: " + error.message);
    return;
  }

  if (statusEl) {
    statusEl.textContent = `Saved: ${exercise_name} – ${reps} reps × ${weight} kg (Score ${score}).`;
  }
  showXpPop("+25 XP (Challenge)");
  addXp(25);
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

  rows.slice(0, 20).forEach((row, index) => {
    const li = document.createElement("li");
    const left = document.createElement("span");
    const right = document.createElement("strong");

    left.textContent = `${index + 1}. ${row.username} – ${row.bestExercise}`;
    right.textContent = `Score ${row.bestScore}`;

    li.append(left, right);
    list.appendChild(li);

    if (row.user_id === myId) {
      myRank = index + 1;
    }
  });

  const rankLabel = document.getElementById("statusRankLabel");
  if (rankLabel) {
    rankLabel.textContent = myRank ? `#${myRank}` : "Not ranked yet";
  }
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
  const addWeightBtn = document.getElementById("addWeightBtn");
  const repeatWorkoutBtn = document.getElementById("repeatWorkoutBtn");
  const weightInput = document.getElementById("workout-weight");
  const intensity = document.getElementById("workout-intensity");
  const muscle1 = document.getElementById("muscle-group");
  const muscle2 = document.getElementById("muscle-group2");

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
      if (weightInput && value.weight) weightInput.value = value.weight;
      showXpPop("Preset loaded");
    } catch { /* ignore */ }
  });
  document.addEventListener("keydown", (event) => {
    const activeTag = document.activeElement?.tagName;
    const typing = activeTag === "INPUT" || activeTag === "TEXTAREA";
    if (event.code === "Space" && !typing) { event.preventDefault(); addSet(); }
    if (event.key === "ArrowRight" && !typing) { event.preventDefault(); addWeightBtn?.click(); }
    if (event.key === "Enter" && !typing) { event.preventDefault(); workoutPage.click(); }
    if ((event.key === "r" || event.key === "R") && !typing) { event.preventDefault(); repeatWorkoutBtn?.click(); }
  });
  workoutPage.addEventListener("click", () => {
    const payload = {
      intensity: intensity?.value, muscle1: muscle1?.value,
      muscle2: muscle2?.value, weight: weightInput?.value,
    };
    localStorage.setItem("lastWorkoutPreset", JSON.stringify(payload));
  });
}

function setupShareActions() {
  document.getElementById("copyShareBtn")?.addEventListener("click", async () => {
    const text = "NEW PR: Deadlift 140kg. Level Up -> 15";
    try { await navigator.clipboard.writeText(text); showXpPop("Copied"); }
    catch { alert(text); }
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
  const missionList = document.getElementById("missionList");
  if (!missionList) return;
  const missionButtons = missionList.querySelectorAll(".mission-toggle");
  const missionPct = document.getElementById("missionPct");
  const updateMissionProgress = () => {
    const done = missionList.querySelectorAll("li.done").length;
    const percent = Math.round((done / missionButtons.length) * 100);
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
      if (nowDone) {
        const xpReward = Number(btn.dataset.xp || "10");
        animateNumber("xpValue", (Number(document.getElementById("xpValue")?.textContent) || 0) + xpReward);
        showXpPop(`+${xpReward} XP`);
      }
      updateMissionProgress();
    });
  });
  updateMissionProgress();
}

function setupLeaderboardRefresh() {
  const refreshBtn = document.getElementById("refreshBoardBtn");
  if (!refreshBtn) return;
  refreshBtn.addEventListener("click", () => {
    loadLeaderboard();
    showXpPop("Leaderboard updated");
  });
  loadLeaderboard();
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
  setupWorkoutShortcuts();
  setupShareActions();
  setupNotifications();
  setupManualToggles();
  setupWgerFilters();
  setupWgerPrimaryLoggers();
  setupWgerFeeds();
  setupChallengeSection();
  setupScrollReveal();
  registerServiceWorker();
}

initUI();

// ─── AUTH ──────────────────────────────────────────────────────────────────────
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
  else { alert("You have been logged out!"); window.location.reload(); }
 });