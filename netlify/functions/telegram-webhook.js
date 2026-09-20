// Pardeh — Telegram approval webhook.
//
// Netlify Function that receives Telegram's callback_query updates when Masoud
// taps a button on a news message.
//
// appr -> reads the pending candidate from content/_pending/<id>.json (via the
//         GitHub API), writes it as a real content/news/<slug>.md file, deletes
//         the pending file, and edits the Telegram message to confirm — with a
//         new "🗑 حذف از سایت" button in case Masoud changes his mind later.
// rej  -> just deletes the pending file and edits the Telegram message.
// del  -> (only appears after an approve) finds the already-published file in
//         content/news/ and deletes it from the site.
//
// The pending item's "image_url" (a generic, rights-cleared thematic photo
// found via the Pexels API in scripts/fetch-and-notify.mjs — never taken from
// the original news source) is carried straight into the published file's
// "image" field. Masoud can always replace it with a specific photo later via
// the "Photo" field in the CMS.
//
// Required environment variables (set in Netlify site settings, never in code):
//   GH_PUBLISH_TOKEN     - a GitHub Personal Access Token with "repo" access
//   GH_REPO              - "Masoudtheater/pardeh-website"
//   TELEGRAM_BOT_TOKEN   - the bot token from @BotFather
//   TELEGRAM_WEBHOOK_SECRET (optional) - shared secret checked against the
//                          X-Telegram-Bot-Api-Secret-Token header, if you set
//                          one when registering the webhook with Telegram.

const GITHUB_TOKEN = process.env.GH_PUBLISH_TOKEN;
const GITHUB_REPO = process.env.GH_REPO;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

const GITHUB_API = "https://api.github.com";

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    if (TELEGRAM_WEBHOOK_SECRET) {
      const got = event.headers["x-telegram-bot-api-secret-token"];
      if (got !== TELEGRAM_WEBHOOK_SECRET) {
        return { statusCode: 401, body: "Unauthorized" };
      }
    }

    if (!GITHUB_TOKEN || !GITHUB_REPO || !TELEGRAM_BOT_TOKEN) {
      console.error("Missing GH_PUBLISH_TOKEN / GH_REPO / TELEGRAM_BOT_TOKEN env vars.");
      return { statusCode: 200, body: "ok" };
    }

    const update = JSON.parse(event.body || "{}");
    const cq = update.callback_query;
    if (!cq) {
      return { statusCode: 200, body: "ok" };
    }

    const data = cq.data || "";
    const [action, id] = data.split(":");
    const chatId = cq.message.chat.id;
    const messageId = cq.message.message_id;

    if (!id || (action !== "appr" && action !== "rej" && action !== "del")) {
      await answerCallback(cq.id, "درخواست نامعتبر");
      return { statusCode: 200, body: "ok" };
    }

    if (action === "del") {
      await handleDelete(cq, chatId, messageId, id);
      return { statusCode: 200, body: "ok" };
    }

    const pendingPath = `content/_pending/${id}.json`;
    const file = await githubGetFile(pendingPath);

    if (!file) {
      await answerCallback(cq.id, "این خبر قبلاً پردازش شده یا پیدا نشد.");
      await editMessage(chatId, messageId, "⚠️ این مورد قبلاً پردازش شده یا دیگر موجود نیست.");
      return { statusCode: 200, body: "ok" };
    }

    const item = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));

    if (action === "rej") {
      await githubDeleteFile(pendingPath, file.sha, `chore: reject news item ${id}`);
      await answerCallback(cq.id, "رد شد.");
      await editMessage(chatId, messageId, `❌ رد شد:\n${item.title_fa || item.title_en || id}`);
      return { statusCode: 200, body: "ok" };
    }

    // action === "appr"
    const slug = `${slugify(item.title_en || id)}-${id}`;
    const finalPath = `content/news/${slug}.md`;
    const frontmatter = buildFrontmatter(item);

    await githubPutFile(finalPath, frontmatter, `content: publish news item ${id}`);
    await githubDeleteFile(pendingPath, file.sha, `chore: clear approved pending item ${id}`);

    await answerCallback(cq.id, "منتشر شد ✅");
    await editMessage(
      chatId,
      messageId,
      `✅ منتشر شد در سایت:\n${item.title_fa || item.title_en || id}`,
      { inline_keyboard: [[{ text: "🗑 حذف از سایت", callback_data: `del:${id}` }]] }
    );

    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("telegram-webhook error:", err);
    // Always answer 200 so Telegram doesn't hammer us with retries.
    return { statusCode: 200, body: "ok" };
  }
};

async function handleDelete(cq, chatId, messageId, id) {
  try {
    const listing = await githubListDir("content/news");
    if (!listing) {
      await answerCallback(cq.id, "پوشه اخبار پیدا نشد.");
      return;
    }
    const match = listing.find((f) => f.type === "file" && f.name.endsWith(`-${id}.md`));
    if (!match) {
      await answerCallback(cq.id, "این خبر قبلاً از سایت حذف شده یا پیدا نشد.");
      await editMessage(chatId, messageId, "⚠️ این خبر قبلاً از سایت حذف شده یا دیگر موجود نیست.");
      return;
    }
    await githubDeleteFile(match.path, match.sha, `chore: remove published news item ${id} (manual undo)`);
    await answerCallback(cq.id, "از سایت حذف شد.");
    await editMessage(chatId, messageId, "🗑 این خبر از سایت حذف شد.");
  } catch (err) {
    console.error("handleDelete error:", err);
    await answerCallback(cq.id, "خطا در حذف. دوباره امتحان کنید.");
  }
}

function slugify(s) {
  const base = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
  return base || "news";
}

function buildFrontmatter(item) {
  const today = new Date().toISOString().slice(0, 10);
  const esc = (s) => String(s || "").replace(/"/g, '\\"');
  return `---
title_en: "${esc(item.title_en)}"
title_fa: "${esc(item.title_fa)}"
excerpt_en: "${esc(item.excerpt_en)}"
excerpt_fa: "${esc(item.excerpt_fa)}"
body_en: "${esc(item.body_en || "")}"
body_fa: "${esc(item.body_fa || "")}"
category: ${item.category === "theatre" ? "theatre" : "cinema"}
scope: ${item.scope === "hamedan" ? "hamedan" : "national"}
byline_en: "${esc(item.source_name || "Editorial")}"
byline_fa: "${esc(item.source_name || "دسک خبر")}"
read_time_en: "2 min read"
read_time_fa: "۲ دقیقه"
date: ${today}
image: "${esc(item.image_url || "")}"
source_url: "${esc(item.source_url || "")}"
source_name: "${esc(item.source_name || "")}"
---
`;
}

async function githubGetFile(path) {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${path}`, {
    headers: ghHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function githubListDir(path) {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${path}`, {
    headers: ghHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET (list) ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function githubPutFile(path, content, message) {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: ghHeaders(),
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
    }),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function githubDeleteFile(path, sha, message) {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${path}`, {
    method: "DELETE",
    headers: ghHeaders(),
    body: JSON.stringify({ message, sha }),
  });
  if (!res.ok) throw new Error(`GitHub DELETE ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function ghHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "pardeh-telegram-webhook",
  };
}

async function answerCallback(callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  }).catch(() => {});
}

async function editMessage(chatId, messageId, text, keyboard) {
  const payload = { chat_id: chatId, message_id: messageId, text };
  if (keyboard) payload.reply_markup = keyboard;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}
