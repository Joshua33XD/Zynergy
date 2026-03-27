const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const STORE_DIR = path.join(__dirname, "data");
const STORE_FILE = path.join(STORE_DIR, "workout-store.json");
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const exerciseCacheMemory = new Map();

const DAY_SEQUENCE = [
  { dayOfWeek: 1, label: "Monday", shortLabel: "Mon" },
  { dayOfWeek: 2, label: "Tuesday", shortLabel: "Tue" },
  { dayOfWeek: 3, label: "Wednesday", shortLabel: "Wed" },
  { dayOfWeek: 4, label: "Thursday", shortLabel: "Thu" },
  { dayOfWeek: 5, label: "Friday", shortLabel: "Fri" },
  { dayOfWeek: 6, label: "Saturday", shortLabel: "Sat" },
  { dayOfWeek: 7, label: "Sunday", shortLabel: "Sun" },
];

function createEmptyState() {
  return {
    splitVersions: [],
    splitDays: [],
    splitHistory: [],
    workoutDayOverrides: [],
    workoutSwaps: [],
    exerciseCache: [],
    manualWorkoutLogs: [],
    manualWorkoutTemplates: [],
  };
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableText(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function parsePositiveInt(value, fieldName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw createHttpError(400, `${fieldName} must be a positive number.`);
  }
  return parsed;
}

function parseNonNegativeNumber(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw createHttpError(400, `${fieldName} must be zero or greater.`);
  }
  return parsed;
}

function validateDateString(value, fieldName = "date") {
  const normalized = normalizeText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw createHttpError(400, `${fieldName} must use YYYY-MM-DD format.`);
  }
  return normalized;
}

function normalizeCacheKey(value) {
  return normalizeText(value).toLowerCase();
}

function getWeekdayMeta(dayOfWeek) {
  return DAY_SEQUENCE.find((entry) => entry.dayOfWeek === dayOfWeek) || null;
}

function computeDayOfWeek(dateString) {
  const [year, month, day] = validateDateString(dateString, "date")
    .split("-")
    .map((part) => Number(part));
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function normalizeSplitDay(rawDay, fallbackDayOfWeek = null) {
  const dayOfWeek = parsePositiveInt(
    rawDay?.dayOfWeek ?? fallbackDayOfWeek,
    "dayOfWeek"
  );
  if (!getWeekdayMeta(dayOfWeek)) {
    throw createHttpError(400, "dayOfWeek must be between 1 and 7.");
  }

  const isRest = Boolean(rawDay?.isRest);
  const workoutLabel = normalizeText(rawDay?.workoutLabel);
  const notes = normalizeNullableText(rawDay?.notes);
  const weekday = getWeekdayMeta(dayOfWeek);

  if (!isRest && !workoutLabel) {
    throw createHttpError(
      400,
      `${weekday.shortLabel} needs a workout label unless it is marked as rest.`
    );
  }

  return {
    dayOfWeek,
    weekdayName: weekday.label,
    shortLabel: weekday.shortLabel,
    isRest,
    workoutLabel: isRest ? "Rest" : workoutLabel,
    notes,
  };
}

function normalizeSplitDays(days, previousDays = []) {
  if (!Array.isArray(days) || !days.length) {
    if (!previousDays.length) {
      throw createHttpError(400, "days must contain 7 entries.");
    }
    days = previousDays;
  }

  const dayMap = new Map();

  previousDays.forEach((day) => {
    const normalized = normalizeSplitDay(day, day.dayOfWeek);
    dayMap.set(normalized.dayOfWeek, normalized);
  });

  days.forEach((day) => {
    const normalized = normalizeSplitDay(day, day?.dayOfWeek);
    dayMap.set(normalized.dayOfWeek, normalized);
  });

  if (dayMap.size !== 7) {
    throw createHttpError(
      400,
      "days must include exactly one entry for each weekday from Monday to Sunday."
    );
  }

  return DAY_SEQUENCE.map(({ dayOfWeek }) => dayMap.get(dayOfWeek));
}

async function ensureStore() {
  try {
    await fs.access(STORE_FILE);
  } catch {
    await fs.mkdir(STORE_DIR, { recursive: true });
    await fs.writeFile(
      STORE_FILE,
      `${JSON.stringify(createEmptyState(), null, 2)}\n`,
      "utf8"
    );
  }
}

async function readState() {
  await ensureStore();
  const raw = await fs.readFile(STORE_FILE, "utf8");
  const parsed = raw ? JSON.parse(raw) : {};
  return {
    ...createEmptyState(),
    ...parsed,
  };
}

async function writeState(state) {
  await fs.writeFile(STORE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function updateState(mutator) {
  const state = await readState();
  const result = await mutator(state);
  await writeState(state);
  return result;
}

function getSplitDaysForVersion(state, versionId) {
  return state.splitDays
    .filter((day) => day.splitVersionId === versionId)
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
    .map((day) => ({
      id: day.id,
      dayOfWeek: day.dayOfWeek,
      weekdayName: day.weekdayName,
      shortLabel: day.shortLabel,
      isRest: day.isRest,
      workoutLabel: day.workoutLabel,
      notes: day.notes || "",
      createdAt: day.createdAt,
    }));
}

function getUserSplitVersions(state, userId) {
  return state.splitVersions
    .filter((version) => version.userId === userId)
    .sort((a, b) => b.versionNo - a.versionNo);
}

function getActiveSplitVersion(state, userId) {
  return (
    state.splitVersions.find(
      (version) => version.userId === userId && version.isActive
    ) || null
  );
}

function hydrateSplitVersion(state, version) {
  if (!version) return null;
  return {
    ...version,
    days: getSplitDaysForVersion(state, version.id),
  };
}

function createSplitVersionRecord({
  userId,
  username,
  name,
  versionNo,
  isActive,
  activatedAt,
}) {
  return {
    id: createId("splitver"),
    userId,
    username: username || "User",
    name,
    versionNo,
    isActive,
    createdAt: activatedAt,
    activatedAt,
    deactivatedAt: null,
  };
}

function appendSplitDays(state, splitVersionId, days, createdAt) {
  days.forEach((day) => {
    state.splitDays.push({
      id: createId("splitday"),
      splitVersionId,
      dayOfWeek: day.dayOfWeek,
      weekdayName: day.weekdayName,
      shortLabel: day.shortLabel,
      isRest: day.isRest,
      workoutLabel: day.workoutLabel,
      notes: day.notes || "",
      createdAt,
    });
  });
}

async function createSplit({ userId, username, name, days }) {
  return updateState((state) => {
    const existingActive = getActiveSplitVersion(state, userId);
    if (existingActive) {
      throw createHttpError(
        409,
        "An active split already exists. Use the edit endpoint to create a new version."
      );
    }

    const priorVersions = getUserSplitVersions(state, userId);
    if (priorVersions.length) {
      throw createHttpError(
        409,
        "Split history already exists for this user. Use the edit endpoint instead."
      );
    }

    const splitName = normalizeText(name) || "My Split";
    const normalizedDays = normalizeSplitDays(days);
    const activatedAt = nowIso();
    const version = createSplitVersionRecord({
      userId,
      username,
      name: splitName,
      versionNo: 1,
      isActive: true,
      activatedAt,
    });

    state.splitVersions.push(version);
    appendSplitDays(state, version.id, normalizedDays, activatedAt);

    return hydrateSplitVersion(state, version);
  });
}

async function getActiveSplit(userId) {
  const state = await readState();
  return hydrateSplitVersion(state, getActiveSplitVersion(state, userId));
}

async function updateActiveSplit({ userId, username, name, days, changeSummary }) {
  return updateState((state) => {
    const previousVersion = getActiveSplitVersion(state, userId);
    if (!previousVersion) {
      throw createHttpError(404, "No active split exists yet.");
    }

    const previousDays = getSplitDaysForVersion(state, previousVersion.id);
    const normalizedDays = normalizeSplitDays(days, previousDays);
    const versionNo = previousVersion.versionNo + 1;
    const activatedAt = nowIso();

    previousVersion.isActive = false;
    previousVersion.deactivatedAt = activatedAt;

    const nextVersion = createSplitVersionRecord({
      userId,
      username,
      name: normalizeText(name) || previousVersion.name,
      versionNo,
      isActive: true,
      activatedAt,
    });

    state.splitVersions.push(nextVersion);
    appendSplitDays(state, nextVersion.id, normalizedDays, activatedAt);

    const historyRecord = {
      id: createId("splithist"),
      userId,
      previousVersionId: previousVersion.id,
      previousVersionNo: previousVersion.versionNo,
      newVersionId: nextVersion.id,
      newVersionNo: nextVersion.versionNo,
      changeSummary: normalizeText(changeSummary) || "Split updated",
      createdAt: activatedAt,
    };

    state.splitHistory.push(historyRecord);

    return {
      split: hydrateSplitVersion(state, nextVersion),
      historyRecord,
    };
  });
}

async function getSplitHistory(userId) {
  const state = await readState();
  const historyByNewVersionId = new Map(
    state.splitHistory
      .filter((entry) => entry.userId === userId)
      .map((entry) => [entry.newVersionId, entry])
  );

  return getUserSplitVersions(state, userId).map((version) => ({
    ...hydrateSplitVersion(state, version),
    historyRecord: historyByNewVersionId.get(version.id) || null,
  }));
}

async function upsertWorkoutOverride({
  userId,
  username,
  overrideDate,
  isRest,
  workoutLabel,
  reason,
}) {
  return updateState((state) => {
    const date = validateDateString(overrideDate, "overrideDate");
    const label = normalizeText(workoutLabel);
    if (!isRest && !label) {
      throw createHttpError(
        400,
        "workoutLabel is required when the override is not a rest day."
      );
    }

    const timestamp = nowIso();
    const existing = state.workoutDayOverrides.find(
      (entry) => entry.userId === userId && entry.overrideDate === date
    );

    if (existing) {
      existing.username = username || existing.username;
      existing.isRest = Boolean(isRest);
      existing.workoutLabel = isRest ? "Rest" : label;
      existing.reason = normalizeNullableText(reason);
      existing.updatedAt = timestamp;
      return existing;
    }

    const override = {
      id: createId("override"),
      userId,
      username: username || "User",
      overrideDate: date,
      isRest: Boolean(isRest),
      workoutLabel: isRest ? "Rest" : label,
      reason: normalizeNullableText(reason),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    state.workoutDayOverrides.push(override);
    return override;
  });
}

async function deleteWorkoutOverride(userId, dateString) {
  const date = validateDateString(dateString, "date");
  return updateState((state) => {
    const before = state.workoutDayOverrides.length;
    state.workoutDayOverrides = state.workoutDayOverrides.filter(
      (entry) => !(entry.userId === userId && entry.overrideDate === date)
    );
    return { deleted: state.workoutDayOverrides.length !== before };
  });
}

async function resolveWorkoutPlan(userId, dateString) {
  const state = await readState();
  const date = validateDateString(dateString, "date");

  const override = state.workoutDayOverrides.find(
    (entry) => entry.userId === userId && entry.overrideDate === date
  );
  if (override) {
    return {
      date,
      source: "override",
      isRest: override.isRest,
      workoutLabel: override.workoutLabel,
      reason: override.reason,
      overrideId: override.id,
    };
  }

  const confirmedSwap = state.workoutSwaps.find(
    (swap) =>
      swap.userId === userId &&
      swap.targetDate === date &&
      swap.status === "confirmed"
  );
  if (confirmedSwap) {
    return {
      date,
      source: "swap",
      isRest: Boolean(confirmedSwap.isRest),
      workoutLabel: confirmedSwap.toWorkout,
      fromWorkout: confirmedSwap.fromWorkout,
      swapId: confirmedSwap.id,
      confirmedAt: confirmedSwap.confirmedAt || null,
    };
  }

  const activeSplit = getActiveSplitVersion(state, userId);
  if (!activeSplit) {
    return {
      date,
      source: "none",
      isRest: false,
      workoutLabel: null,
      message: "No active split found.",
    };
  }

  const dayOfWeek = computeDayOfWeek(date);
  const splitDay = getSplitDaysForVersion(state, activeSplit.id).find(
    (day) => day.dayOfWeek === dayOfWeek
  );

  if (!splitDay) {
    return {
      date,
      source: "none",
      isRest: false,
      workoutLabel: null,
      message: "The active split does not include a day for this date.",
    };
  }

  return {
    date,
    source: "split",
    isRest: splitDay.isRest,
    workoutLabel: splitDay.workoutLabel,
    notes: splitDay.notes || "",
    splitVersionId: activeSplit.id,
    splitName: activeSplit.name,
    versionNo: activeSplit.versionNo,
    dayOfWeek: splitDay.dayOfWeek,
    weekdayName: splitDay.weekdayName,
  };
}

async function createWorkoutSwap({
  userId,
  username,
  targetDate,
  fromWorkout,
  toWorkout,
  isRest,
}) {
  const date = validateDateString(targetDate, "targetDate");
  const fromLabel = normalizeText(fromWorkout);
  const toLabel = normalizeText(toWorkout);

  if (!fromLabel) {
    throw createHttpError(400, "fromWorkout is required.");
  }
  if (!isRest && !toLabel) {
    throw createHttpError(400, "toWorkout is required.");
  }

  return updateState((state) => {
    const swap = {
      id: createId("swap"),
      userId,
      username: username || "User",
      targetDate: date,
      fromWorkout: fromLabel,
      toWorkout: isRest ? "Rest" : toLabel,
      isRest: Boolean(isRest),
      status: "pending",
      requestedAt: nowIso(),
      confirmedAt: null,
      cancelledAt: null,
    };

    state.workoutSwaps.push(swap);
    return swap;
  });
}

async function confirmWorkoutSwap(userId, swapId) {
  return updateState((state) => {
    const swap = state.workoutSwaps.find(
      (entry) => entry.userId === userId && entry.id === swapId
    );
    if (!swap) {
      throw createHttpError(404, "Swap request not found.");
    }
    if (swap.status === "confirmed") return swap;
    if (swap.status === "cancelled") {
      throw createHttpError(409, "This swap has already been cancelled.");
    }

    swap.status = "confirmed";
    swap.confirmedAt = nowIso();
    return swap;
  });
}

async function cancelWorkoutSwap(userId, swapId) {
  return updateState((state) => {
    const swap = state.workoutSwaps.find(
      (entry) => entry.userId === userId && entry.id === swapId
    );
    if (!swap) {
      throw createHttpError(404, "Swap request not found.");
    }
    if (swap.status === "cancelled") return swap;

    swap.status = "cancelled";
    swap.cancelledAt = nowIso();
    return swap;
  });
}

async function listRecentPlanActivity(userId, limit = 8, type = "all") {
  const state = await readState();
  const filterType = normalizeText(type).toLowerCase();
  const overrides = state.workoutDayOverrides
    .filter((entry) => entry.userId === userId)
    .map((entry) => ({
      id: entry.id,
      type: "override",
      date: entry.overrideDate,
      label: entry.isRest ? "Rest" : entry.workoutLabel,
      reason: entry.reason,
      status: "active",
      createdAt: entry.updatedAt || entry.createdAt,
    }));

  const swaps = state.workoutSwaps
    .filter((entry) => entry.userId === userId && entry.status !== "cancelled")
    .map((entry) => ({
      id: entry.id,
      type: "swap",
      date: entry.targetDate,
      label: entry.toWorkout,
      fromWorkout: entry.fromWorkout,
      status: entry.status,
      createdAt: entry.confirmedAt || entry.requestedAt,
    }));

  const combined = [...overrides, ...swaps].sort((a, b) => {
    const timeA = new Date(a.createdAt || 0).getTime();
    const timeB = new Date(b.createdAt || 0).getTime();
    return timeB - timeA;
  });

  const filtered =
    filterType && filterType !== "all"
      ? combined.filter((entry) => entry.type === filterType)
      : combined;

  return filtered.slice(0, Math.max(1, Number(limit) || 8));
}

async function getCachedExerciseResult(cacheKey, nowMs, ttlMs) {
  const memoryHit = exerciseCacheMemory.get(cacheKey);
  if (memoryHit && memoryHit.expiresAt > nowMs) {
    return { hit: true, data: memoryHit.data };
  }

  const state = await readState();
  const record = state.exerciseCache.find((entry) => entry.cacheKey === cacheKey);
  if (record && record.expiresAt > nowMs) {
    exerciseCacheMemory.set(cacheKey, {
      data: record.data,
      expiresAt: record.expiresAt,
    });
    return { hit: true, data: record.data };
  }

  return { hit: false, data: null };
}

async function setCachedExerciseResult(cacheKey, data, nowMs, ttlMs) {
  const expiresAt = nowMs + ttlMs;

  exerciseCacheMemory.set(cacheKey, { data, expiresAt });

  return updateState((state) => {
    const existing = state.exerciseCache.find((entry) => entry.cacheKey === cacheKey);
    if (existing) {
      existing.data = data;
      existing.cachedAt = nowIso();
      existing.expiresAt = expiresAt;
      return existing;
    }

    const record = {
      id: createId("excache"),
      cacheKey,
      data,
      cachedAt: nowIso(),
      expiresAt,
    };
    state.exerciseCache.push(record);
    return record;
  });
}

async function getCachedExerciseSearch(query, options = {}) {
  const ttlMs = Number(options.ttlMs || DEFAULT_CACHE_TTL_MS);
  const cacheKey = `search:${normalizeCacheKey(query)}:${normalizeCacheKey(
    options.muscle || ""
  )}`;
  const nowMs = Date.now();

  return getCachedExerciseResult(cacheKey, nowMs, ttlMs);
}

async function setCachedExerciseSearch(query, options, data) {
  const ttlMs = Number(options?.ttlMs || DEFAULT_CACHE_TTL_MS);
  const cacheKey = `search:${normalizeCacheKey(query)}:${normalizeCacheKey(
    options?.muscle || ""
  )}`;
  return setCachedExerciseResult(cacheKey, data, Date.now(), ttlMs);
}

async function getCachedExerciseById(id, ttlMs = DEFAULT_CACHE_TTL_MS) {
  const cacheKey = `exercise:${normalizeCacheKey(id)}`;
  return getCachedExerciseResult(cacheKey, Date.now(), ttlMs);
}

async function setCachedExerciseById(id, data, ttlMs = DEFAULT_CACHE_TTL_MS) {
  const cacheKey = `exercise:${normalizeCacheKey(id)}`;
  return setCachedExerciseResult(cacheKey, data, Date.now(), ttlMs);
}

function normalizeManualPayload(payload, { requireName = false } = {}) {
  const exercise = normalizeText(payload?.exercise);
  if (!exercise) {
    throw createHttpError(400, "exercise is required.");
  }

  const name = normalizeText(payload?.name);
  if (requireName && !name) {
    throw createHttpError(400, "name is required.");
  }

  return {
    name: name || `${exercise} template`,
    exercise,
    sets: parsePositiveInt(payload?.sets, "sets"),
    reps: parsePositiveInt(payload?.reps, "reps"),
    weight: parseNonNegativeNumber(payload?.weight ?? 0, "weight"),
    notes: normalizeNullableText(payload?.notes),
    entryDate: payload?.entryDate
      ? validateDateString(payload.entryDate, "entryDate")
      : null,
    templateId: normalizeNullableText(payload?.templateId),
  };
}

async function saveManualWorkoutLog({
  userId,
  username,
  exercise,
  sets,
  reps,
  weight,
  notes,
  entryDate,
  templateId,
}) {
  const normalized = normalizeManualPayload({
    exercise,
    sets,
    reps,
    weight,
    notes,
    entryDate,
    templateId,
  });

  return updateState((state) => {
    const loggedAt = nowIso();
    const manualLog = {
      id: createId("manuallog"),
      userId,
      username: username || "User",
      exercise: normalized.exercise,
      sets: normalized.sets,
      reps: normalized.reps,
      weight: normalized.weight,
      notes: normalized.notes,
      entryDate:
        normalized.entryDate || new Date().toISOString().slice(0, 10),
      templateId: normalized.templateId,
      source: normalized.templateId ? "template" : "manual",
      loggedAt,
    };

    state.manualWorkoutLogs.push(manualLog);
    return manualLog;
  });
}

async function createManualWorkoutTemplate({
  userId,
  username,
  name,
  exercise,
  sets,
  reps,
  weight,
  notes,
}) {
  const normalized = normalizeManualPayload(
    { name, exercise, sets, reps, weight, notes },
    { requireName: false }
  );

  return updateState((state) => {
    const timestamp = nowIso();
    const template = {
      id: createId("manualtpl"),
      userId,
      username: username || "User",
      name: normalized.name,
      exercise: normalized.exercise,
      sets: normalized.sets,
      reps: normalized.reps,
      weight: normalized.weight,
      notes: normalized.notes,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    state.manualWorkoutTemplates.push(template);
    return template;
  });
}

async function listManualWorkoutTemplates(userId) {
  const state = await readState();
  return state.manualWorkoutTemplates
    .filter((template) => template.userId === userId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function updateManualWorkoutTemplate(userId, templateId, payload) {
  const normalized = normalizeManualPayload(payload, { requireName: false });

  return updateState((state) => {
    const template = state.manualWorkoutTemplates.find(
      (entry) => entry.userId === userId && entry.id === templateId
    );
    if (!template) {
      throw createHttpError(404, "Template not found.");
    }

    template.name = normalized.name;
    template.exercise = normalized.exercise;
    template.sets = normalized.sets;
    template.reps = normalized.reps;
    template.weight = normalized.weight;
    template.notes = normalized.notes;
    template.updatedAt = nowIso();

    return template;
  });
}

async function deleteManualWorkoutTemplate(userId, templateId) {
  return updateState((state) => {
    const before = state.manualWorkoutTemplates.length;
    state.manualWorkoutTemplates = state.manualWorkoutTemplates.filter(
      (entry) => !(entry.userId === userId && entry.id === templateId)
    );
    return { deleted: state.manualWorkoutTemplates.length !== before };
  });
}

module.exports = {
  DAY_SEQUENCE,
  DEFAULT_CACHE_TTL_MS,
  cancelWorkoutSwap,
  confirmWorkoutSwap,
  createHttpError,
  createSplit,
  createWorkoutSwap,
  createManualWorkoutTemplate,
  deleteManualWorkoutTemplate,
  deleteWorkoutOverride,
  getActiveSplit,
  getCachedExerciseById,
  getCachedExerciseSearch,
  getSplitHistory,
  listRecentPlanActivity,
  listManualWorkoutTemplates,
  resolveWorkoutPlan,
  saveManualWorkoutLog,
  setCachedExerciseById,
  setCachedExerciseSearch,
  updateActiveSplit,
  updateManualWorkoutTemplate,
  upsertWorkoutOverride,
  validateDateString,
};
