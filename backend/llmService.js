const Groq = require("groq-sdk");

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Fallback chain: chất lượng cao → nhẹ hơn khi bị rate limit
const MODELS = [
  "llama-3.3-70b-versatile",   // primary — tốt nhất
  "llama-3.1-8b-instant",      // fallback — nhanh, ít token hơn nhiều
  "gemma2-9b-it",              // fallback 2
];

async function callGroq(params) {
  for (const model of MODELS) {
    try {
      return await client.chat.completions.create({ ...params, model });
    } catch (err) {
      const is429 = err?.status === 429 || err?.message?.includes("rate_limit");
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
async function chatFollowUp(messages, context) {
  const ctxLines = context
    ? [
        `Địa điểm: "${context.destination}"`,
        `\nTÓM TẮT TỪ REVIEW: ${context.neutral_summary || ""}`,
        `\nNHỮNG GÌ REVIEWER THÍCH (với quote thật):`,
        ...(context.liked || []).map((l) => `  • ${l.text} — "${l.quote}"`),
        `\nPHÀN NÀN PHỔ BIẾN (với quote thật):`,
        ...(context.complaints || []).map((c) => `  • ${c.text} — "${c.quote}"`),
        `\nPATTERNS PHÁT HIỆN TỪ REVIEW:`,
        ...(context.truth_patterns || []).map((p) => `  • ${p.pattern}: ${p.insight}`),
        `\nPHÙ HỢP VỚI: ${(context.traveler_fit?.best_for || []).join(", ")}`,
        `KHÔNG PHÙ HỢP: ${(context.traveler_fit?.avoid_if || []).join(", ")}`,
      ].join("\n")
    : "Chưa có dữ liệu review nào được crawl.";

  const systemPrompt =
    `Bạn là Remy, AI tổng hợp insight từ review du lịch thực tế.\n\n` +
    `DỮ LIỆU CRAWL ĐƯỢC TỪ CÁC NGUỒN REVIEW:\n${ctxLines}\n\n` +
    `RULES TUYỆT ĐỐI:\n` +
    `- CHỈ trả lời dựa trên dữ liệu review đã crawl ở trên\n` +
    `- KHÔNG dùng kiến thức chung, KHÔNG bịa đặt thông tin\n` +
    `- Nếu dữ liệu crawl KHÔNG đề cập đến điều user hỏi → nói thẳng: "Mình chưa tìm thấy thông tin này trong các review đã đọc về [địa điểm]. Bạn thử hỏi trực tiếp trên các group du lịch nhé!"\n` +
    `- Trích dẫn cụ thể từ review khi có thể (vd: "Theo review trên vnexpress...")\n` +
    `- Ngắn gọn, thân thiện, dùng tiếng Việt\n` +
    `- Nếu câu hỏi về địa điểm mới: "Hỏi tôi '[tên địa điểm] review' để tôi đi tìm thông tin nhé!"`;

  const res = await callGroq({
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.slice(-8), // keep last 8 turns
    ],
    max_tokens: 450,
    temperature: 0.75,
  });

  return res.choices[0].message.content.trim();
}

module.exports = { extractDestination, analyzeReviews, chatFollowUp, detectNewDestination };
