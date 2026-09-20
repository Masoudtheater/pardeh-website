// Pardeh — daily news automation.
//
// Runs on a schedule inside GitHub Actions (see .github/workflows/daily-news.yml).
// 1. Reads RSS feeds listed in scripts/news-sources.json
// 2. Skips anything already seen before (tracked in data/seen-news.json)
// 3. Sends the new raw items to Google Gemini (free-tier API) to select, summarize,
//    and translate the best ~8 stories for a Hamedan/Iran cinema & theatre audience
// 4. Looks up a generic, rights-cleared thematic photo for each candidate from the
//    Pexels API (free, no attribution required) — never from the original news
//    source site, and never claiming to depict the exact film/production
// 5. Pushes each candidate straight to GitHub as content/_pending/<id>.json via the
//    API (not local git) so the file is live and findable the INSTANT the Telegram
//    message goes out — this is what fixes the old "already processed / not found"
//    race condition, where tapping Approve before the end-of-job git push finished
//    could fail because the pending file wasn't on GitHub yet
// 6. Sends each candidate to Masoud on Telegram (with the photo, if one was found)
//    with Approve / Reject buttons
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

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPOSITORY; // "owner/repo" — provided automatically by GitHub Actions
const PEXELS_API_KEY = process.env.PEXELS_API_KEY; // optional — no image lookup if unset

const GITHUB_API = "https://api.github.com";

const MAX_ITEMS_TO_MODEL = 40;
const MAX_ITEMS_TO_SELECT = 8;
const SEEN_TTL_DAYS = 30;

function requireEnv() {
  const missing = [];
  if (!GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
  if (!TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!TELEGRAM_CHAT_ID) missing.push("TELEGRAM_CHAT_ID");
  if (!GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (!GITHUB_REPO) missing.push("GITHUB_REPOSITORY");
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
3. Also write your OWN slightly longer original write-up ("body") of 3-5 sentences covering the same story in more depth, still in your own words — never copied verbatim from the snippet. This is what readers see on the site itself, so they don't need to visit the original source.
4. Provide English and Persian versions of the title, the short excerpt, and the longer body. The Persian text must be natural, fluent Persian — not a literal word-for-word translation.
5. Classify "category" as exactly "cinema" or "theatre" (best guess if unclear; default "cinema").
6. Classify "scope" as exactly "hamedan" only if the item is specifically about Hamedan province, otherwise "national".
7. Keep "source_url" as the exact LINK given, unchanged — it is kept only for internal record-keeping and is not shown to readers.

Respond with ONLY a JSON array (no markdown fences, no commentary before or after), where each element has exactly these fields:
[{
  "title_en": "...",
  "title_fa": "...",
  "excerpt_en": "...",
  "excerpt_fa": "...",
  "body_en": "...",
  "body_fa": "...",
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

// ---------- image lookup (Pexels) ----------
//
// We deliberately do NOT try to find a photo of the exact film/play being
// reported on — a free stock library won't have official production stills,
// and guessing based on the headline risks pulling an unrelated person's
// photo into a news item about them. Instead we pick a real, high-quality,
// clearly generic/thematic photo (a stage, a cinema, a film set) — safe to
// reuse under Pexels' free commercial license, and never taken from the
// original news source site. Masoud can always replace it with a specific,
// rights-cleared photo later via the "Photo" field in the CMS.
const IMAGE_QUERY_POOL = {
  theatre: [
    "theatre stage performance",
    "theater curtain stage lighting",
    "actors performing on stage",
    "empty theatre auditorium",
  ],
  cinema: [
    "cinema film reel",
    "movie theater screen glow",
    "film camera on set",
    "cinema audience watching screen",
  ],
};

function pickImageQuery(item, id) {
  const pool = IMAGE_QUERY_POOL[item.category] || IMAGE_QUERY_POOL.cinema;
  let sum = 0;
  for (const ch of String(id)) sum += ch.charCodeAt(0);
  return pool[sum % pool.length];
}

async function fetchPexelsImage(item, id) {
  if (!PEXELS_API_KEY) return "";
  const query = pickImageQuery(item, id);
  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`,
      { headers: { Authorization: PEXELS_API_KEY } }
    );
    if (!res.ok) {
      console.warn(`Pexels search failed (${res.status}) for "${query}"`);
      return "";
    }
    const data = await res.json();
    const photo = data.photos && data.photos[0];
    return photo ? photo.src.large : "";
  } catch (err) {
    console.warn(`Pexels lookup error: ${err.message}`);
    return "";
  }
}

// ---------- GitHub (push pending items immediately, no local git needed) ----------

async function githubPutFile(filePath, content, message) {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${filePath}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "pardeh-news-bot",
    },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
    }),
  });
  if (!res.ok) {
    throw new Error(`GitHub PUT ${filePath} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ---------- Telegram ----------

async function sendTelegramMessage(text, id, imageUrl) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ تایید و انتشار", callback_data: `appr:${id}` },
        { text: "❌ رد کردن", callback_data: `rej:${id}` },
      ],
    ],
  };

  if (imageUrl) {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        photo: imageUrl,
        caption: text.slice(0, 1000), // Telegram caption limit is 1024 chars
        parse_mode: "HTML",
        reply_markup: keyboard,
      }),
    });
    if (res.ok) return;
    console.warn(`Telegram sendPhoto failed (${res.status}), falling back to text-only message.`);
  }

  const res2 = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      reply_markup: keyboard,
    }),
  });
  if (!res2.ok) {
    console.warn(`Telegram send failed: ${res2.status} ${await res2.text()}`);
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

  let sentCount = 0;
  for (const item of selected) {
    if (!item || !item.source_url) continue;
    const id = hashLink(item.source_url);

    const image_url = await fetchPexelsImage(item, id);
    const payload = { ...item, id, image_url, created_at: new Date().toISOString() };

    try {
      await githubPutFile(
        `content/_pending/${id}.json`,
        JSON.stringify(payload, null, 2),
        `chore: queue news candidate ${id} for approval`
      );
    } catch (err) {
      // If we can't get the pending file onto GitHub, don't send a Telegram
      // message for it either — that's exactly the old race condition
      // (an Approve button pointing at a file that isn't there yet).
      console.error(`Failed to push pending item ${id} to GitHub, skipping: ${err.message}`);
      continue;
    }

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
    await sendTelegramMessage(text, id, image_url);
    sentCount++;
  }

  for (const it of fresh) {
    seen[it._hash] = now;
  }
  await writeFile(SEEN_PATH, JSON.stringify(seen, null, 2));

  console.log(`Done. ${sentCount} candidate(s) sent to Telegram for approval.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
