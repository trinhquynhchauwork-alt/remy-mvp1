require("dotenv").config();
const express = require("express");
const path = require("path");
const { gatherReviews } = require("./searchService");
const { extractDestination, analyzeReviews, chatFollowUp, detectNewDestination } = require("./llmService");

const app = express();
app.use(express.json());

// Serve frontend tĩnh — không cần port riêng nữa
app.use(express.static(path.join(__dirname, "../frontend")));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "Remy AI Travel Review" });
});


// ── Full analysis (first message) ─────────────────────
app.post("/api/analyze", async (req, res) => {
  try {
    const question = (req.body?.question || "").trim();
    if (!question) return res.status(400).json({ error: "Vui lòng nhập câu hỏi" });
    if (question.length < 5) return res.status(400).json({ error: "Câu hỏi quá ngắn" });

    console.log(`\n[analyze] "${question}"`);

    const destination = await extractDestination(question);
    console.log(`[destination] ${destination}`);

    const reviewData = await gatherReviews(destination);
    console.log(`[reviews] ${reviewData.texts.length} texts / ${reviewData.sources_found} URLs`);

    const result = await analyzeReviews(destination, reviewData);

    // ── Attach sources ──
    result.sources = reviewData.texts.map((t) => {
      let domain = t.url;
      try { domain = new URL(t.url).hostname.replace(/^www\./, ""); } catch {}
      const title = t.text.split("\n").find((l) => l.trim().length > 15)?.slice(0, 90) || domain;
      return { url: t.url, domain, title };
    });

    res.json(result);
  } catch (err) {
    console.error("[analyze error]", err.message);
    res.status(500).json({ error: `Có lỗi xảy ra: ${err.message}` });
  }
});

// ── Smart unified endpoint ─────────────────────────────
// Tự detect: địa điểm mới → full analyze | hỏi thêm → quick chat
app.post("/api/smart", async (req, res) => {
  try {
    const { message, history = [], context } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "Thiếu message" });

    console.log(`\n[smart] "${message.slice(0, 60)}"`);

    const isNew = !context || await detectNewDestination(message, context?.destination);
    console.log(`[smart] intent → ${isNew ? "new_destination" : "followup"}`);

    if (isNew) {
      const destination = await extractDestination(message);
      console.log(`[smart] destination: ${destination}`);
      const reviewData = await gatherReviews(destination);
      const result = await analyzeReviews(destination, reviewData);
      result.sources = reviewData.texts.map((t) => {
        let domain = t.url;
        try { domain = new URL(t.url).hostname.replace(/^www\./, ""); } catch {}
        const title = t.text.split("\n").find((l) => l.trim().length > 15)?.slice(0, 90) || domain;
        return { url: t.url, domain, title };
      });
      return res.json({ type: "analysis", data: result });
    } else {
      const fullHistory = [...history, { role: "user", content: message }];
      const reply = await chatFollowUp(fullHistory, context);
      return res.json({ type: "chat", reply });
    }
  } catch (err) {
    console.error("[smart error]", err.message);
    res.status(500).json({ error: `Có lỗi xảy ra: ${err.message}` });
  }
});

// ── Follow-up chat (subsequent messages) ──────────────
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, context } = req.body;
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: "Thiếu messages" });
    }

    console.log(`\n[chat] "${messages.at(-1)?.content?.slice(0, 60)}"`);
    const reply = await chatFollowUp(messages, context);
    res.json({ reply });
  } catch (err) {
    console.error("[chat error]", err.message);
    res.status(500).json({ error: `Có lỗi xảy ra: ${err.message}` });
  }
});

// Local dev
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`\n🧳 Remy backend đang chạy tại http://localhost:${PORT}`);
    console.log(`   GROQ key : ${process.env.GROQ_API_KEY ? "✓ loaded" : "✗ MISSING"}`);
    console.log(`   BRAVE key: ${process.env.BRAVE_API_KEY ? "✓ loaded" : "✗ MISSING"}\n`);
  });
}

// Vercel serverless export
module.exports = app;
