const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Groq = require("groq-sdk");
const {
  createHttpError,
  createManualWorkoutTemplate,
  createSplit,
  createWorkoutSwap,
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
  confirmWorkoutSwap,
  cancelWorkoutSwap,
  upsertWorkoutOverride,
  validateDateString,
} = require("./workout-store");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const apiKey = process.env.GROQ_API_KEY || process.env.groq_key;
if (!apiKey) {
  console.warn(
    "Missing GROQ_API_KEY (or groq_key) in .env. Chat endpoint will fail until you set it."
  );
}

const groq = new Groq({ apiKey });

const coaches = [
  {
    id: "sam_sulek",
    name: "Sam Sulek",
    icon: "S",
    image: "/pics_for_coach/sam%20sulek.jpeg",
    blurb: "High-energy hypertrophy coach focused on intensity and momentum.",
    systemPrompt:
      "You are Sam Sulek style coach for ZYNERGY. Keep advice direct, gym-practical, and motivating. Prioritize simple hypertrophy actions with clear sets, reps, and progression.",
  },
  {
    id: "togi",
    name: "Togi",
    icon: "T",
    image: "/pics_for_coach/togi.jpeg",
    blurb: "Discipline-first coach emphasizing consistency, structure, and form.",
    systemPrompt:
      "You are Togi style coach for ZYNERGY. Focus on discipline, execution, and clean form cues. Keep plans realistic and repeatable for busy users.",
  },
  {
    id: "cbum",
    name: "C Bum",
    icon: "C",
    image: "/pics_for_coach/c%20bum.jpeg",
    blurb: "Balanced aesthetic coach for smart volume and recovery.",
    systemPrompt:
      "You are C Bum style coach for ZYNERGY. Give balanced bodybuilding guidance with emphasis on technique, sustainable volume, and recovery.",
  },
  {
    id: "ronnie_coleman",
    name: "Ronnie Coleman",
    icon: "R",
    image: "/pics_for_coach/ronnie%20coleman.jpeg",
    blurb: "Power-focused coach for strength mindset and progressive overload.",
    systemPrompt:
      "You are Ronnie Coleman style coach for ZYNERGY. Be energetic and strength-focused. Give clear progressive overload advice with safe form reminders.",
  },
  {
    id: "all_star",
    name: "All-Star Coach",
    icon: "A",
    image: null,
    blurb: "Blended coach style combining hypertrophy, discipline, recovery, and strength.",
    systemPrompt:
      "You are ZYNERGY All-Star Coach. Blend Sam Sulek intensity, Togi discipline, C Bum balance, and Ronnie Coleman strength mindset. Keep replies concise, actionable, supportive, and safe.",
  },
];

const EXERCISE_IMAGE_BASE =
  "https://images.pexels.com/photos/416778/pexels-photo-416778.jpeg?auto=compress&cs=tinysrgb&w=800";
const EXERCISE_IMAGE_STRENGTH =
  "https://images.pexels.com/photos/949126/pexels-photo-949126.jpeg?auto=compress&cs=tinysrgb&w=800";
const EXERCISE_IMAGE_CABLE =
  "https://images.pexels.com/photos/1552106/pexels-photo-1552106.jpeg?auto=compress&cs=tinysrgb&w=800";
const EXERCISE_IMAGE_BODYWEIGHT =
  "https://images.pexels.com/photos/414029/pexels-photo-414029.jpeg?auto=compress&cs=tinysrgb&w=800";

const EXERCISE_CATALOG = [
  { id: "bb_bench_press", name: "Barbell Bench Press", muscle: "Chest", equipment: "Barbell", image: EXERCISE_IMAGE_STRENGTH },
  { id: "db_bench_press", name: "Dumbbell Bench Press", muscle: "Chest", equipment: "Dumbbell", image: EXERCISE_IMAGE_STRENGTH },
  { id: "incline_db_press", name: "Incline Dumbbell Press", muscle: "Chest", equipment: "Dumbbell", image: EXERCISE_IMAGE_STRENGTH },
  { id: "push_up", name: "Push-up", muscle: "Chest", equipment: "Bodyweight", image: EXERCISE_IMAGE_BODYWEIGHT },
  { id: "bb_squat", name: "Barbell Back Squat", muscle: "Legs", equipment: "Barbell", image: EXERCISE_IMAGE_STRENGTH },
  { id: "front_squat", name: "Front Squat", muscle: "Legs", equipment: "Barbell", image: EXERCISE_IMAGE_STRENGTH },
  { id: "romanian_deadlift", name: "Romanian Deadlift", muscle: "Legs", equipment: "Barbell", image: EXERCISE_IMAGE_STRENGTH },
  { id: "leg_press", name: "Leg Press", muscle: "Legs", equipment: "Machine", image: EXERCISE_IMAGE_BASE },
  { id: "conventional_deadlift", name: "Conventional Deadlift", muscle: "Back", equipment: "Barbell", image: EXERCISE_IMAGE_STRENGTH },
  { id: "bb_row", name: "Barbell Row", muscle: "Back", equipment: "Barbell", image: EXERCISE_IMAGE_STRENGTH },
  { id: "seated_cable_row", name: "Seated Cable Row", muscle: "Back", equipment: "Cable", image: EXERCISE_IMAGE_CABLE },
  { id: "lat_pulldown", name: "Lat Pulldown", muscle: "Back", equipment: "Cable", image: EXERCISE_IMAGE_CABLE },
  { id: "ohp", name: "Overhead Press", muscle: "Shoulders", equipment: "Barbell", image: EXERCISE_IMAGE_STRENGTH },
  { id: "lateral_raise", name: "Dumbbell Lateral Raise", muscle: "Shoulders", equipment: "Dumbbell", image: EXERCISE_IMAGE_STRENGTH },
  { id: "rear_delt_fly", name: "Rear Delt Fly", muscle: "Shoulders", equipment: "Dumbbell", image: EXERCISE_IMAGE_STRENGTH },
  { id: "bb_curl", name: "Barbell Curl", muscle: "Biceps", equipment: "Barbell", image: EXERCISE_IMAGE_STRENGTH },
  { id: "db_curl", name: "Alternating Dumbbell Curl", muscle: "Biceps", equipment: "Dumbbell", image: EXERCISE_IMAGE_STRENGTH },
  { id: "hammer_curl", name: "Hammer Curl", muscle: "Biceps", equipment: "Dumbbell", image: EXERCISE_IMAGE_STRENGTH },
  { id: "skullcrusher", name: "Skullcrusher", muscle: "Triceps", equipment: "Barbell", image: EXERCISE_IMAGE_STRENGTH },
  { id: "rope_pushdown", name: "Cable Rope Pushdown", muscle: "Triceps", equipment: "Cable", image: EXERCISE_IMAGE_CABLE },
  { id: "dip", name: "Parallel Bar Dip", muscle: "Triceps", equipment: "Bodyweight", image: EXERCISE_IMAGE_BODYWEIGHT },
];

function getUserContext(req) {
  const userId =
    req.get("x-user-id") ||
    req.body?.userId ||
    req.query?.userId ||
    req.params?.userId;
  const username =
    req.get("x-username") || req.body?.username || req.query?.username || "User";

  if (!userId || typeof userId !== "string") {
    throw createHttpError(
      401,
      "A signed-in user is required. Pass x-user-id from the authenticated client."
    );
  }

  return {
    userId: userId.trim(),
    username: typeof username === "string" ? username.trim() || "User" : "User",
  };
}

function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500) {
        console.error("API error:", error);
      }
      res.status(status).json({
        error: error?.message || "Unexpected server error.",
      });
    }
  };
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/coaches", (_req, res) => {
  res.json({
    coaches: coaches.map(({ id, name, icon, image, blurb, systemPrompt }) => ({
      id,
      name,
      icon,
      image,
      blurb,
      systemPrompt,
    })),
  });
});

app.post(
  "/api/splits",
  asyncRoute(async (req, res) => {
    const { userId, username } = getUserContext(req);
    const split = await createSplit({
      userId,
      username,
      name: req.body?.name,
      days: req.body?.days,
    });
    res.status(201).json({ split });
  })
);

app.get(
  "/api/splits/active",
  asyncRoute(async (req, res) => {
    const { userId } = getUserContext(req);
    const split = await getActiveSplit(userId);
    res.json({ split });
  })
);

app.put(
  "/api/splits/active",
  asyncRoute(async (req, res) => {
    const { userId, username } = getUserContext(req);
    const result = await updateActiveSplit({
      userId,
      username,
      name: req.body?.name,
      days: req.body?.days,
      changeSummary: req.body?.changeSummary,
    });
    res.json(result);
  })
);

app.get(
  "/api/splits/history",
  asyncRoute(async (req, res) => {
    const { userId } = getUserContext(req);
    const versions = await getSplitHistory(userId);
    res.json({ versions });
  })
);

app.get(
  "/api/workouts/plan",
  asyncRoute(async (req, res) => {
    const { userId } = getUserContext(req);
    const requestedDate = req.query?.date
      ? validateDateString(req.query.date, "date")
      : new Date().toISOString().slice(0, 10);
    const plan = await resolveWorkoutPlan(userId, requestedDate);
    res.json(plan);
  })
);

app.get(
  "/api/workouts/activity",
  asyncRoute(async (req, res) => {
    const { userId } = getUserContext(req);
    const limit = Number(req.query?.limit || 8);
    const type = typeof req.query?.type === "string" ? req.query.type.trim() : "all";
    const activity = await listRecentPlanActivity(userId, limit, type);
    res.json({ activity });
  })
);

app.put(
  "/api/workouts/override",
  asyncRoute(async (req, res) => {
    const { userId, username } = getUserContext(req);
    const override = await upsertWorkoutOverride({
      userId,
      username,
      overrideDate: req.body?.overrideDate,
      isRest: req.body?.isRest,
      workoutLabel: req.body?.workoutLabel,
      reason: req.body?.reason,
    });
    res.json({ override });
  })
);

app.delete(
  "/api/workouts/override/:date",
  asyncRoute(async (req, res) => {
    const { userId } = getUserContext(req);
    const result = await deleteWorkoutOverride(userId, req.params.date);
    res.json(result);
  })
);

app.post(
  "/api/workouts/swap",
  asyncRoute(async (req, res) => {
    const { userId, username } = getUserContext(req);
    const swap = await createWorkoutSwap({
      userId,
      username,
      targetDate: req.body?.targetDate,
      fromWorkout: req.body?.fromWorkout,
      toWorkout: req.body?.toWorkout,
      isRest: req.body?.isRest,
    });
    res.status(201).json({ swap });
  })
);

app.post(
  "/api/workouts/swap/:id/confirm",
  asyncRoute(async (req, res) => {
    const { userId } = getUserContext(req);
    const swap = await confirmWorkoutSwap(userId, req.params.id);
    res.json({ swap });
  })
);

app.post(
  "/api/workouts/swap/:id/cancel",
  asyncRoute(async (req, res) => {
    const { userId } = getUserContext(req);
    const swap = await cancelWorkoutSwap(userId, req.params.id);
    res.json({ swap });
  })
);

app.post(
  "/api/workouts/manual/log",
  asyncRoute(async (req, res) => {
    const { userId, username } = getUserContext(req);
    const log = await saveManualWorkoutLog({
      userId,
      username,
      exercise: req.body?.exercise,
      sets: req.body?.sets,
      reps: req.body?.reps,
      weight: req.body?.weight,
      notes: req.body?.notes,
      entryDate: req.body?.entryDate,
      templateId: req.body?.templateId,
    });
    res.status(201).json({ log });
  })
);

app.post(
  "/api/workouts/manual/template",
  asyncRoute(async (req, res) => {
    const { userId, username } = getUserContext(req);
    const template = await createManualWorkoutTemplate({
      userId,
      username,
      name: req.body?.name,
      exercise: req.body?.exercise,
      sets: req.body?.sets,
      reps: req.body?.reps,
      weight: req.body?.weight,
      notes: req.body?.notes,
    });
    res.status(201).json({ template });
  })
);

app.get(
  "/api/workouts/manual/templates",
  asyncRoute(async (req, res) => {
    const { userId } = getUserContext(req);
    const templates = await listManualWorkoutTemplates(userId);
    res.json({ templates });
  })
);

app.put(
  "/api/workouts/manual/template/:id",
  asyncRoute(async (req, res) => {
    const { userId } = getUserContext(req);
    const template = await updateManualWorkoutTemplate(
      userId,
      req.params.id,
      req.body || {}
    );
    res.json({ template });
  })
);

app.delete(
  "/api/workouts/manual/template/:id",
  asyncRoute(async (req, res) => {
    const { userId } = getUserContext(req);
    const result = await deleteManualWorkoutTemplate(userId, req.params.id);
    res.json(result);
  })
);

app.get(
  "/api/exercises/search",
  asyncRoute(async (req, res) => {
    const query = typeof req.query?.q === "string" ? req.query.q.trim() : "";
    if (!query) {
      res.status(400).json({ error: "q is required." });
      return;
    }

    const muscle = typeof req.query?.muscle === "string" ? req.query.muscle.trim() : "";
    const { hit, data } = await getCachedExerciseSearch(query, { muscle });
    if (hit) {
      res.json({ cached: true, results: data });
      return;
    }

    const lower = query.toLowerCase();
    const results = EXERCISE_CATALOG.filter((exercise) => {
      if (!exercise.name.toLowerCase().includes(lower)) return false;
      if (muscle && exercise.muscle.toLowerCase() !== muscle.toLowerCase()) {
        return false;
      }
      return true;
    }).slice(0, 24);

    await setCachedExerciseSearch(query, { muscle }, results);
    res.json({ cached: false, results });
  })
);

app.get(
  "/api/exercises/:id",
  asyncRoute(async (req, res) => {
    const id = req.params.id;
    const { hit, data } = await getCachedExerciseById(id);
    if (hit) {
      res.json({ cached: true, exercise: data });
      return;
    }

    const exercise = EXERCISE_CATALOG.find((item) => item.id === id);
    if (!exercise) {
      res.status(404).json({ error: "Exercise not found." });
      return;
    }

    await setCachedExerciseById(id, exercise);
    res.json({ cached: false, exercise });
  })
);

app.post("/chat", async (req, res) => {
  try {
    const body = req.body || {};
    const message = typeof body.message === "string" ? body.message : "";
    const messages = Array.isArray(body.messages) ? body.messages : null;

    const promptMessages =
      messages && messages.length
        ? messages
        : [
            {
              role: "system",
              content:
                "You are ZYNERGY's witty, motivating gym coach. Keep replies concise, actionable, and supportive.",
            },
            { role: "user", content: message || "Say hi." },
          ];

    const completion = await groq.chat.completions.create({
      model: body.model || "llama-3.3-70b-versatile",
      messages: promptMessages,
      temperature: typeof body.temperature === "number" ? body.temperature : 0.8,
      max_completion_tokens:
        typeof body.max_completion_tokens === "number"
          ? body.max_completion_tokens
          : 512,
    });

    const reply = completion?.choices?.[0]?.message?.content ?? "";
    res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Chat failed" });
  }
});

app.use(express.static(path.resolve(__dirname)));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`ZYNERGY server running on port ${port}`));
