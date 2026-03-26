const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Groq = require("groq-sdk");

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
];

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
