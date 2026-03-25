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

app.get("/health", (_req, res) => res.json({ ok: true }));

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

