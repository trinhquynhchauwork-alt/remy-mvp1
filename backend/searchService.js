const axios = require("axios");

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const JINA_BASE = "https://r.jina.ai/";

const SKIP_DOMAINS = ["youtube.com", "twitter.com", "instagram.com", "tiktok.com"];

// Thứ tự ưu tiên: Google Maps → Facebook → Travel blogs → Travel communities
const PREFERRED_DOMAINS = [
  // Tier 1: Google Maps / Google Reviews
  "google.com/maps",
  "maps.google.com",
  // Tier 2: Facebook public posts/groups
  "facebook.com",
  // Tier 3: Travel blogs
  "vnexpress.net",
  "kenh14.vn",
  "dantri.com.vn",
  "mia.vn",
  "dulichviet.com.vn",
  "baomoi.com",
  // Tier 4: Travel communities & booking platforms
  "tripadvisor.com",
  "traveloka.com",
  "trip.com",
  "agoda.com",
  "foody.vn",
  "ivivu.com",
  "reddit.com",
];

// Giới hạn số nguồn mỗi domain để đa dạng hóa
const MAX_PER_DOMAIN = 2;

async function searchBrave(query, count = 8) {
  if (!BRAVE_API_KEY) throw new Error("BRAVE_API_KEY chưa được cấu hình trong .env");

  const res = await axios.get("https://api.search.brave.com/res/v1/web/search", {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": BRAVE_API_KEY,
    },
    params: { q: query, count },
    timeout: 10000,
  });

  const results = res.data?.web?.results || [];
  return results
    .map((r) => r.url)
    .filter((url) => url && !SKIP_DOMAINS.some((d) => url.includes(d)));
}

function sortByQuality(urls) {
  return [...urls].sort((a, b) => {
    // So sánh theo thứ tự ưu tiên (PREFERRED_DOMAINS dùng substring match)
    const rank = (url) => {
      const idx = PREFERRED_DOMAINS.findIndex((d) => url.includes(d));
      return idx === -1 ? 999 : idx;
    };
    return rank(a) - rank(b);
  });
}

async function extractJina(url, maxChars = 2500) {
  try {
    const res = await axios.get(`${JINA_BASE}${url}`, {
      headers: { Accept: "text/plain", "X-Return-Format": "text", "X-Timeout": "12" },
      timeout: 14000,
      responseType: "text",
    });
    const text = (res.data || "").trim();
    return text.length > 150 ? text.slice(0, maxChars) : null;
  } catch {
    return null;
  }
}

// Thử lấy Google Maps reviews trực tiếp qua Jina
// Jina dùng headless browser nên đôi khi đọc được một phần
async function fetchGoogleMapsReviews(destination, maxChars = 3000) {
  // Tìm Google Maps listing qua Brave trước
  try {
    const res = await axios.get("https://api.search.brave.com/res/v1/web/search", {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": BRAVE_API_KEY,
      },
      params: { q: `${destination} site:google.com/maps`, count: 3 },
      timeout: 8000,
    });

    const mapsUrls = (res.data?.web?.results || [])
      .map((r) => r.url)
      .filter((u) => u.includes("google.com/maps"));

    if (!mapsUrls.length) return null;

    // Thử từng URL — Google Maps thường block, nhưng đôi khi Jina qua được
    for (const url of mapsUrls.slice(0, 2)) {
      const text = await extractJina(url, maxChars, 10); // timeout ngắn hơn
      if (text && text.length > 200) {
        console.log(`[maps] extracted ${text.length} chars from ${url}`);
        return { url, text };
      }
    }
  } catch (e) {
    console.log("[maps] Google Maps fetch skipped:", e.message);
  }
  return null;
}

async function gatherReviews(destination, maxExtract = 5) {
  const queries = [
    `${destination} google maps đánh giá review nhận xét`,          // Google Maps reviews
    `site:facebook.com ${destination} review đánh giá kinh nghiệm`, // Facebook posts
    `${destination} review blog kinh nghiệm du lịch`,               // Travel blogs
    `${destination} traveloka tripadvisor trip.com đánh giá`,        // Travel communities
  ];

  // Chạy tất cả Brave queries SONG SONG thay vì tuần tự → tiết kiệm ~30s
  const searchResults = await Promise.allSettled(
    queries.map((q) =>
      searchBrave(q).then((urls) => {
        console.log(`[search] "${q.slice(0, 40)}" → ${urls.length} URLs`);
        return urls;
      })
    )
  );

  const allUrls = [];
  for (const r of searchResults) {
    if (r.status === "fulfilled") allUrls.push(...r.value);
  }

  // Deduplicate + sort by quality
  const unique = [...new Map(allUrls.map((u) => [u, u])).values()];
  const sorted = sortByQuality(unique);

  const reviewData = { urls: sorted, texts: [], sources_found: sorted.length };
  if (!sorted.length) return reviewData;

  // Cap per-domain để đa dạng nguồn
  const domainCount = {};
  const balanced = [];
  for (const url of sorted) {
    let domain = url;
    try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch {}
    const base = domain.split(".").slice(-2).join(".");
    domainCount[base] = (domainCount[base] || 0) + 1;
    if (domainCount[base] <= MAX_PER_DOMAIN) balanced.push(url);
    if (balanced.length >= maxExtract + 3) break;
  }

  // Extract in parallel
  const candidates = balanced.slice(0, maxExtract + 3);
  const extractions = await Promise.allSettled(
    candidates.map((url) => extractJina(url).then((text) => ({ url, text })))
  );

  for (const result of extractions) {
    if (result.status === "fulfilled" && result.value.text) {
      reviewData.texts.push(result.value);
      console.log(`[jina] ${result.value.text.length} chars from ${result.value.url}`);
      if (reviewData.texts.length >= maxExtract) break;
    }
  }

  return reviewData;
}

// Quick search cho follow-up questions — 2 queries, tối đa 3 kết quả
async function gatherReviewsQuick(destination, question) {
  const queries = [
    `${destination} ${question}`,
    `site:facebook.com ${destination} ${question}`,
  ];

  const searchResults = await Promise.allSettled(
    queries.map((q) => searchBrave(q, 5))
  );

  const allUrls = [];
  for (const r of searchResults) {
    if (r.status === "fulfilled") allUrls.push(...r.value);
  }

  const unique = [...new Map(allUrls.map((u) => [u, u])).values()];
  const sorted = sortByQuality(unique);

  const reviewData = { texts: [], sources_found: sorted.length };
  if (!sorted.length) return reviewData;

  const candidates = sorted.slice(0, 5);
  const extractions = await Promise.allSettled(
    candidates.map((url) => extractJina(url).then((text) => ({ url, text })))
  );

  for (const result of extractions) {
    if (result.status === "fulfilled" && result.value.text) {
      reviewData.texts.push(result.value);
      if (reviewData.texts.length >= 3) break;
    }
  }

  return reviewData;
}

module.exports = { gatherReviews, gatherReviewsQuick };
