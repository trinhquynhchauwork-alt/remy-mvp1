const axios = require("axios");

// Fallback chain: chất lượng cao → nhẹ hơn khi bị rate limit
const MODELS = [
  "llama-3.3-70b-versatile",   // primary — tốt nhất
  "llama-3.1-8b-instant",      // fallback — nhanh, ít token hơn nhiều
  "gemma2-9b-it",              // fallback 2
];

// Dùng axios thay groq-sdk để tránh connection issue trên Vercel
async function callGroq(params) {
  for (const model of MODELS) {
    try {
      const res = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        { ...params, model },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        }
      );
      return res.data;
    } catch (err) {
      const status = err?.response?.status;
      const is429 = status === 429 || err?.response?.data?.error?.code === "rate_limit_exceeded";
      if (is429 && model !== MODELS.at(-1)) {
        console.warn(`[groq] rate limit on ${model}, trying next model...`);
        continue;
      }
      throw err;
    }
  }
}

const SYSTEM_PROMPT = `Bạn là Remy, AI phân tích review du lịch trung lập và chuyên nghiệp tại Việt Nam.

NHIỆM VỤ: Phân tích đánh giá du lịch từ nhiều nguồn, trả về JSON theo đúng schema.

RULES TUYỆT ĐỐI:
1. Chỉ trích dẫn từ review thật được cung cấp - KHÔNG bịa đặt bất kỳ quote nào
2. "count" là ước tính số lần topic được nhắc đến trong tổng số nguồn
3. Trung lập - không dùng từ "nên đi" hay "không nên đi"
4. Phát hiện truth patterns: ảnh vs thực tế, contradictions, hidden timing tips
5. Traveler-fit phải cụ thể và thực tế, dựa trên nội dung review
6. neutral_summary 2-3 câu, phải chứa ít nhất một quote ngắn từ review gốc
7. Output: JSON object thuần túy - KHÔNG markdown, KHÔNG \`\`\`json wrapper

JSON SCHEMA BẮT BUỘC:
{
  "destination": "tên đầy đủ địa điểm",
  "sources_analyzed": <number>,
  "liked": [{"text": "...", "count": <number>, "quote": "..."}],
  "complaints": [{"text": "...", "count": <number>, "quote": "..."}],
  "truth_patterns": [{"pattern": "...", "insight": "..."}],
  "traveler_fit": {"best_for": ["..."], "avoid_if": ["..."]},
  "neutral_summary": "...",
  "follow_up_questions": ["...","...","..."]
}`;

async function extractDestination(question) {
  try {
    const res = await callGroq({

      messages: [
        {
          role: "system",
          content:
            "Trích xuất tên địa điểm du lịch từ câu hỏi tiếng Việt. Chỉ trả về tên địa điểm đầy đủ, không giải thích. Ví dụ: 'Vinpearl Nha Trang', 'Cù Lao Câu', 'Đà Lạt'.",
        },
        { role: "user", content: question },
      ],
      max_tokens: 60,
      temperature: 0,
    });
    return res.choices[0].message.content.trim().replace(/\.$/, "");
  } catch (e) {
    console.error("[llm] extractDestination failed:", e.message);
    return question;
  }
}

async function analyzeReviews(destination, reviewData) {
  const { texts = [], sources_found = 0 } = reviewData;

  const combined = texts
    .map((t, i) => {
      const domain = t.url.split("/")[2] || t.url;
      return `=== NGUỒN ${i + 1} [${domain}] ===\n${t.text}`;
    })
    .join("\n\n")
    .slice(0, 8000) || "Không tìm thấy đủ nội dung review cho địa điểm này.";

  const userMessage =
    `Phân tích các đánh giá về "${destination}".\n\n` +
    `Tổng URLs tìm được: ${sources_found} | Đã đọc nội dung: ${texts.length} nguồn\n\n` +
    `NỘI DUNG REVIEW:\n${combined}\n\n` +
    `YÊU CẦU:\n` +
    `- "sources_analyzed" = ${sources_found}\n` +
    `- liked: 3-5 điểm nổi bật\n` +
    `- complaints: 2-4 vấn đề phổ biến\n` +
    `- truth_patterns: 2-3 patterns thú vị\n` +
    `- follow_up_questions: 3 câu hỏi người đọc muốn biết tiếp\n` +
    `Trả về JSON object hợp lệ theo schema đã định nghĩa.`;

  try {
    const res = await callGroq({

      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      max_tokens: 2500,
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(res.choices[0].message.content);
    fillDefaults(result, destination, sources_found);
    return result;
  } catch (e) {
    console.error("[llm] analyzeReviews failed:", e.message);
    return fallback(destination, sources_found);
  }
}

function fillDefaults(r, destination, sources_found) {
  r.destination ??= destination;
  r.sources_analyzed ??= sources_found;
  r.liked ??= [];
  r.complaints ??= [];
  r.truth_patterns ??= [];
  r.traveler_fit ??= {};
  r.traveler_fit.best_for ??= [];
  r.traveler_fit.avoid_if ??= [];
  r.neutral_summary ??= `Chưa có đủ dữ liệu để phân tích ${destination}.`;
  r.follow_up_questions ??= [];
}

function fallback(destination, sources_found) {
  return {
    destination,
    sources_analyzed: sources_found,
    liked: [],
    complaints: [],
    truth_patterns: [],
    traveler_fit: { best_for: [], avoid_if: [] },
    neutral_summary: `Không thể phân tích dữ liệu về ${destination} lúc này. Vui lòng thử lại.`,
    follow_up_questions: [],
  };
}

// ── Intent detection ───────────────────────────────────
async function detectNewDestination(message, currentDestination) {
  try {
    const res = await callGroq({

      messages: [
        {
          role: "system",
          content:
            'Phân loại câu hỏi du lịch. Trả về JSON: {"type":"new_destination"} hoặc {"type":"followup"}.\n' +
            '"new_destination" = hỏi review/đánh giá/kinh nghiệm về một địa điểm mới hoặc khác với địa điểm hiện tại.\n' +
            '"followup" = hỏi thêm về địa điểm đang thảo luận, hoặc câu hỏi chung không cần tìm nguồn mới.',
        },
        {
          role: "user",
          content: `Địa điểm đang thảo luận: "${currentDestination || "chưa có"}"\nCâu hỏi: "${message}"`,
        },
      ],
      max_tokens: 20,
      temperature: 0,
      response_format: { type: "json_object" },
    });
    const result = JSON.parse(res.choices[0].message.content);
    return result.type === "new_destination";
  } catch {
    // Nếu không detect được → coi như follow-up để tránh query thừa
    return false;
  }
}

// ── Follow-up chat ─────────────────────────────────────
async function chatFollowUp(messages, context, extraReviews = []) {
  const ctxLines = context
    ? [
        `Địa điểm: "${context.destination}"`,
        `\nTÓM TẮT TỪ REVIEW BAN ĐẦU: ${context.neutral_summary || ""}`,
        `\nNHỮNG GÌ REVIEWER THÍCH:`,
        ...(context.liked || []).map((l) => `  • ${l.text} — "${l.quote}"`),
        `\nPHÀN NÀN PHỔ BIẾN:`,
        ...(context.complaints || []).map((c) => `  • ${c.text} — "${c.quote}"`),
        `\nPATTERNS:`,
        ...(context.truth_patterns || []).map((p) => `  • ${p.pattern}: ${p.insight}`),
      ].join("\n")
    : "Chưa có dữ liệu review nào được crawl.";

  // Data mới tìm theo câu hỏi cụ thể
  const extraCtx = extraReviews.length > 0
    ? "\n\n--- DỮ LIỆU BỔ SUNG (tìm kiếm theo câu hỏi này) ---\n" +
      extraReviews
        .map((r, i) => {
          const domain = (() => { try { return new URL(r.url).hostname.replace(/^www\./, ""); } catch { return r.url; } })();
          return `[Nguồn ${i + 1}: ${domain}]\n${r.text.slice(0, 2000)}`;
        })
        .join("\n\n")
        .slice(0, 5000)
    : "";

  const systemPrompt =
    `Bạn là Remy, AI tổng hợp insight từ review du lịch thực tế.\n\n` +
    `DỮ LIỆU CRAWL ĐƯỢC:\n${ctxLines}${extraCtx}\n\n` +
    `RULES:\n` +
    `- Ưu tiên trả lời từ "DỮ LIỆU BỔ SUNG" nếu có liên quan đến câu hỏi\n` +
    `- Nếu không có data liên quan → nói thẳng: "Mình chưa tìm thấy thông tin này trong review về ${context?.destination || "địa điểm này"}"\n` +
    `- CHỈ dùng thông tin từ dữ liệu crawl, KHÔNG bịa đặt\n` +
    `- Trích dẫn nguồn khi có thể (vd: "Theo review trên traveloka...")\n` +
    `- Ngắn gọn, thân thiện, tiếng Việt`;

  const res = await callGroq({
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.slice(-8),
    ],
    max_tokens: 500,
    temperature: 0.7,
  });

  return res.choices[0].message.content.trim();
}

module.exports = { extractDestination, analyzeReviews, chatFollowUp, detectNewDestination };
