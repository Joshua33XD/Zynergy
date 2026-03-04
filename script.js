
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
    alert("Nutrition data saved successfully!");
  }
}

window.getValues = getValues;
window.saveSleepData = saveSleepData;
window.saveNutritionData = saveNutritionData;

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
