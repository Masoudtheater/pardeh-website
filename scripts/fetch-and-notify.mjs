// Pardeh — daily news automation.
//
// Runs on a schedule inside GitHub Actions (see .github/workflows/daily-news.yml).
// 1. Reads RSS feeds listed in scripts/news-sources.json
// 2. Skips anything already seen before (tracked in data/seen-news.json)
// 3. Sends the new raw items to Google Gemini (free-tier API) to select, summarize,
//    and translate the best ~8 stories for a Hamedan/Iran cinema & theatre audience
// 4. Writes each selected candidate as a small pending file under content/_pending/
// 5. Sends each candidate to Masoud on Telegram with Approve / Reject buttons
//
// Nothing is ever published to the live site from this script directly — approval
// happens in Telegram, and the actual publish step lives in
// netlify/functions/telegram-webhook.js

import Parser from "rss-parser";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SOURCES_PATH = path.join(ROOT, "scripts", "news-sources.json");
const SEEN_PATH = path.join(ROOT, "data", "seen-news.json");
const PENDING_DIR = path.join(ROOT, "content", "_pending");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const MAX_ITEMS_TO_MODEL = 40;
const MAX_ITEMS_TO_SELECT = 8;
const SEEN_TTL_DAYS = 30;

function requireEnv() {
  const missing = [];
  if (!GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
  if (!TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!TELEGRAM_CHAT_ID) missing.push("TELEGRAM_CHAT_ID");
  if (missing.length) {
    console.error(`Missing required environment variable(s): ${missing.join(", ")}`);
    process.exit(1);
  }
}

function hashLink(link) {
  return crypto.createHash("sha256").update(link).digest("hex").slice(0, 12);
}

async function loadJson(p, fallback) {
  try {
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function fetchAllFeeds(sources) {
  const parser = new Parser({ timeout: 15000 });
  const items = [];
  for (const feed of sources.feeds) {
    try {
      const parsed = await parser.parseURL(feed.url);
      for (const it of parsed.items || []) {
        if (!it.link) continue;
        items.push({
          source: feed.name,
          link: it.link,
          title: it.title || "",
          snippet: (it.contentSnippet || it.content || it.summary || "").slice(0, 600),
          pubDate: it.pubDate || it.isoDate || "",
        });
      }
      console.log(`OK   ${feed.name} (${parsed.items?.length || 0} items)`);
    } catch (err) {
      console.warn(`FAIL ${feed.name}: ${err.message}`);
    }
  }
  return items;
}

function buildPrompt(items) {
  const list = items
    .map(
      (it, i) =>
        `#${i + 1}\nSOURCE: ${it.source}\nLINK: ${it.link}\nTITLE: ${it.title}\nSNIPPET: ${it.snippet}\nDATE: ${it.pubDate}`
    )
    .join("\n\n");

  return `You are the daily news editor for "Pardeh", a bilingual (English/Persian) arts & culture website focused on Iranian cinema and theatre, with a special pilot focus on Hamedan province, Iran. You also cover major international cinema/theatre news.

Below is a numbered list of raw news items gathered today from RSS feeds (a mix of Persian and English sources, including some noise unrelated to arts).

TASK:
1. Select the ${MAX_ITEMS_TO_SELECT} most relevant and interesting items for this audience. Priority order: (a) anything explicitly about Hamedan province, (b) Iranian cinema/theatre news generally, (c) major international cinema/theatre news. Skip anything not about cinema, theatre, or the performing/film arts. Skip near-duplicate stories, keeping only the best version.
2. For each selected item, write your OWN short original summary — do not copy sentences verbatim from the snippet. 1-2 sentences, neutral editorial tone.
3. Provide both an English and a Persian version of the title and summary. The Persian text must be natural, fluent Persian — not a literal word-for-word translation.
4. Classify "category" as exactly "cinema" or "theatre" (best guess if unclear; default "cinema").
5. Classify "scope" as exactly "hamedan" only if the item is specifically about Hamedan province, otherwise "national".
6. Keep "source_url" as the exact LINK given, unchanged.

Respond with ONLY a JSON array (no markdown fences, no commentary before or after), where each element has exactly these fields:
[{
  "title_en": "...",
  "title_fa": "...",
  "excerpt_en": "...",
  "excerpt_fa": "...",
  "category": "cinema",
  "scope": "national",
  "source_name": "...",
  "source_url": "..."
}]

If nothing in the list is relevant, respond with an empty JSON array: []

RAW ITEMS:
${list}`;
}

// Try the lightweight, stable model first (usually far less congested than the
// newest flagship model), then fall back to the newer flagship if needed.
// If Google renames/retires a model again, add the new name to the FRONT of
// this list rather than replacing it, so older fallbacks still work.
const MODELS = ["gemini-3.1-flash-lite", "gemini-3.8-flash", "gemini-flash-latest"];
const RETRYABLE_STATUS = new Set([429, 500, 503, 504]);
const RETRY_DELAYS_MS = [4000, 10000]; // up to 2 retries per model: 4s, 10s

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callModelWithRetries(model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error(`Model ${model} returned no text in its response.`);
      return text;
    }

    const bodyText = (await res.text()).slice(0, 500);
    const err = new Error(`Gemini API error ${res.status} (model ${model}): ${bodyText}`);

    const canRetry = RETRYABLE_STATUS.has(res.status) && attempt < RETRY_DELAYS_MS.length;
    if (!canRetry) throw err;

    const delay = RETRY_DELAYS_MS[attempt];
    console.warn(`${model} returned ${res.status} (temporary). Retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length})`);
    await sleep(delay);
  }
}

async function callGemini(items) {
  const prompt = buildPrompt(items);
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, responseMimeType: "application/json" },
  });

  let lastErr;
  for (const model of MODELS) {
    try {
      const text = await callModelWithRetries(model, body);
      let cleaned = text.trim();
      if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
      }
      const parsed = JSON.parse(cleaned);
      console.log(`Gemini call succeeded using model: ${model}`);
      return parsed;
    } catch (err) {
      console.warn(`${model} failed after retries: ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendTelegramMessage(text, id) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ تایید و انتشار", callback_data: `appr:${id}` },
            { text: "❌ رد کردن", callback_data: `rej:${id}` },
          ],
        ],
      },
    }),
  });
  if (!res.ok) {
    console.warn(`Telegram send failed: ${res.status} ${await res.text()}`);
  }
}

async function sendTelegramNote(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
  }).catch(() => {});
}

async function main() {
  requireEnv();
  await mkdir(PENDING_DIR, { recursive: true });
  await mkdir(path.dirname(SEEN_PATH), { recursive: true });

  const sources = await loadJson(SOURCES_PATH, { feeds: [] });
  const seen = await loadJson(SEEN_PATH, {});

  const now = Date.now();
  const ttlMs = SEEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  for (const [hash, ts] of Object.entries(seen)) {
    if (now - ts > ttlMs) delete seen[hash];
  }

  console.log(`Fetching ${sources.feeds.length} feeds...`);
  const allItems = await fetchAllFeeds(sources);
  console.log(`Fetched ${allItems.length} raw items total.`);

  const fresh = [];
  for (const it of allItems) {
    const h = hashLink(it.link);
    if (!seen[h]) fresh.push({ ...it, _hash: h });
  }
  console.log(`${fresh.length} item(s) are new (not seen in a previous run).`);

  if (fresh.length === 0) {
    console.log("Nothing new today — exiting without contacting Gemini or Telegram.");
    await writeFile(SEEN_PATH, JSON.stringify(seen, null, 2));
    return;
  }

  const toModel = fresh.slice(0, MAX_ITEMS_TO_MODEL);
  let selected;
  try {
    selected = await callGemini(toModel);
  } catch (err) {
    console.error("Gemini call failed:", err.message);
    await sendTelegramNote(`⚠️ اجرای امروز خودکارسازی اخبار با خطا مواجه شد:\n${escapeHtml(err.message)}`);
    process.exitCode = 1;
    return;
  }

  if (!Array.isArray(selected)) {
    console.error("Gemini did not return a JSON array. Raw:", selected);
    selected = [];
  }

  if (selected.length === 0) {
    console.log("Model selected no relevant items today.");
  }

  for (const item of selected) {
    if (!item || !item.source_url) continue;
    const id = hashLink(item.source_url);
    const pendingPath = path.join(PENDING_DIR, `${id}.json`);
    await writeFile(
      pendingPath,
      JSON.stringify({ ...item, id, created_at: new Date().toISOString() }, null, 2)
    );

    const scopeLabel = item.scope === "hamedan" ? "📍 همدان" : "🌍 ملی/بین‌المللی";
    const catLabel = item.category === "theatre" ? "🎭 تئاتر" : "🎬 سینما";
    const text = [
      `<b>${escapeHtml(item.title_fa)}</b>`,
      escapeHtml(item.excerpt_fa),
      "",
      `${catLabel} · ${scopeLabel}`,
      `منبع: ${escapeHtml(item.source_name || "")}`,
      escapeHtml(item.source_url),
    ].join("\n");
    await sendTelegramMessage(text, id);
  }

  for (const it of fresh) {
    seen[it._hash] = now;
  }
  await writeFile(SEEN_PATH, JSON.stringify(seen, null, 2));

  console.log(`Done. ${selected.length} candidate(s) sent to Telegram for approval.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
