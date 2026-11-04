const DEFAULT_MODEL = "gemini-3.5-flash-lite";

const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;

const TOTAL_RESPONSE_BUDGET_MS = 3900;
const SERPER_TIMEOUT_MS = 2800;
const GEMINI_TIMEOUT_MS = 3400;
const RESPONSE_RESERVE_MS = 350;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и понятно.",
  "Обычно используй 1–3 коротких предложения.",
  "Не используй Markdown, таблицы и длинные вступления.",
  "Не выдумывай факты. Если не знаешь ответа, скажи об этом."
].join(" ");

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!text) return "Не удалось подготовить ответ.";
  if (text.length <= MAX_ALICE_TEXT) return text;

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );

  if (sentenceEnd >= 250) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate) + "…";
}

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: { text: fitAliceText(text), end_session: endSession },
    session_state: { history }
  };
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item =>
      item &&
      (item.role === "user" || item.role === "model") &&
      typeof item.text === "string"
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({
      role: item.role,
      text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS)
    }));
}

function lastUserMessage(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") return history[i].text;
  }
  return "";
}

function isFollowUp(text) {
  const value = String(text || "").trim().toLowerCase().replace(/ё/g, "е");
  return /^(?:а\s*)?(?:именно+|подробнее|подробней|поподробнее|поподробней|подробности|какие именно|что именно|расскажи подробнее|расскажи поподробнее|а подробнее|можно подробнее|и что дальше|конкретнее|поясни|поясни подробнее|это как|почему|где именно|кто именно)[?!.,\s]*$/i.test(value);
}

function lastSearchContext(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item.role === "user" && !isFollowUp(item.text) && isSearchIntent(item.text)) {
      return item.text;
    }
  }
  return "";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные|происходит|произошл|случил|событи|обстановк|в городе|что в [а-яё-]+/i.test(text);
}

function buildSearchQuery(text, history) {
  const previous = lastSearchContext(history);
  if (isFollowUp(text) && previous) {
    return previous + " последние конкретные события подробности";
  }

  const query = String(text || "").trim();
  if (/что происходит|что случилось|что произошло/i.test(query)) {
    return query + " последние новости конкретные события сегодня";
  }
  return query;
}

async function fetchJson(url, options, timeoutMs, stage) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(100, timeoutMs));

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } catch (error) {
    if (timedOut || error?.name === "AbortError") {
      const timeoutError = new Error(`${stage}_TIMEOUT`);
      timeoutError.code = `${stage}_TIMEOUT`;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error("MISSING_SERPER_KEY");

  const { response, data } = await fetchJson(
    "https://google.serper.dev/search",
    {
      method: "POST",
      headers: {
        "X-API-KEY": key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 8 })
    },
    timeoutMs,
    "SERPER"
  );

  if (!response.ok) {
    console.warn("Serper HTTP error:", response.status);
    throw new Error("SERPER_REQUEST_FAILED");
  }

  const organic = Array.isArray(data.organic) ? data.organic : [];
  return {
    answerBox: String(data.answerBox?.answer || data.answerBox?.snippet || "").trim(),
    snippets: organic.slice(0, 8).map(item => ({
      title: String(item.title || "").trim(),
      snippet: String(item.snippet || "").trim()
    })).filter(item => item.title || item.snippet)
  };
}

function cleanNewsTitle(value) {
  let title = String(value || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/[\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.{2,}/g, "")
    .replace(/[|•]+/g, " ")
    .trim();

  title = title.replace(/^(?:омск-информ|бк\s*55|город\s*55|inci\s*55|инцидент омск|риа новости)\s*[:—-]\s*/i, "");
  title = title.replace(/^(?:последние новости|главные новости|новости)\s+(?:омска|омск[а-яё]*)(?:\s+и\s+омской областью?)?[^.!?]{0,90}[.!?]\s*/i, "");
  title = title.replace(/^(?:омск\s*[-—:]\\s*)?(?:последние новости сегодня|новости омска и омской области|новости омска и области)[.!?\s—:-]*/i, "");

  const pieces = title.split(/\s+[·|]\s+|\s+—\s+/).map(part => part.trim()).filter(Boolean);
  if (pieces.length > 1) {
    const meaningful = pieces.find(part => isUsefulNewsTitle(part));
    if (meaningful) title = meaningful;
  }

  return title.replace(/[.!?;:,]+$/g, "").trim();
}

function isUsefulNewsTitle(title) {
  const value = String(title || "").trim();
  if (value.length < 8 || value.length > 220) return false;

  const genericPatterns = [
    /^новости\b/i,
    /^главные новости/i,
    /^последние новости/i,
    /^новости сегодня/i,
    /^смотреть онлайн/i,
    /^фото и видео/i,
    /^официальный сайт/i,
    /^погода в/i,
    /^карта сайта/i,
    /^инцидент\s*\d*$/i,
    /^(?:омск-информ|бк\s*55|город\s*55|inci\s*55|инцидент омск)\b/i,
    /^новости омска и/i,
    /^главные события омска/i,
    /^омск\.?$/i,
    /^читайте последние новости/i,
    /^последние новости омска/i,
    /^новости омска сегодня/i
  ];

  return !genericPatterns.some(pattern => pattern.test(value));
}

function usefulSnippetLead(value) {
  const text = String(value || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^(?:омск-информ|бк\s*55|город\s*55|риа новости)\s*[:—-]\s*/i, "")
    .trim();
  if (text.length < 35) return "";

  const firstSentence = text.split(/(?<=[.!?])\s+/)[0].trim();
  const candidate = firstSentence.length >= 35 ? firstSentence : text.slice(0, 180).trim();
  if (/^(?:читайте|подписывайтесь|смотрите|главные новости|последние новости|новости омска)/i.test(candidate)) return "";
  return candidate.slice(0, 190).replace(/[.!?;:,]+$/g, "").trim();
}

function makeSearchAnswer(result) {
  const seen = new Set();
  const raw = Array.isArray(result.snippets) ? result.snippets : [];
  console.info("Serper organic results:", JSON.stringify(raw.slice(0, 6).map(item => ({
    title: item.title,
    snippet: String(item.snippet || "").slice(0, 220)
  }))));

  const items = raw
    .map(item => {
      const originalTitle = cleanNewsTitle(item.title);
      const snippet = String(item.snippet || "").replace(/\s+/g, " ").trim();
      const title = isUsefulNewsTitle(originalTitle)
        ? originalTitle
        : usefulSnippetLead(snippet);
      return { title, snippet };
    })
    .filter(item => item.title && isUsefulNewsTitle(item.title))
    .filter(item => {
      const key = item.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);

  if (items.length) {
    const parts = items.slice(0, 3).map(item => {
      const description = item.snippet
        .replace(/https?:\/\/\S+/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      if (
        description.length >= 45 &&
        description.toLowerCase() !== item.title.toLowerCase() &&
        !item.title.toLowerCase().includes(description.slice(0, 35).toLowerCase())
      ) {
        return item.title + ". " + description.slice(0, 260);
      }
      return item.title;
    });

    if (parts.length === 1) return fitAliceText("Вот что удалось найти. " + parts[0]);
    return fitAliceText("Вот конкретные новости. " + parts.join(". Ещё событие: ") + ".");
  }

  const answer = cleanNewsTitle(result.answerBox || "");
  if (answer.length > 35 && isUsefulNewsTitle(answer)) {
    return fitAliceText(answer);
  }

  return "Поиск нашёл страницы, но в них не удалось надёжно выделить заголовки событий. Попробуй спросить о конкретной теме или районе.";
}
async function askGemini(text, history, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));
  contents.push({ role: "user", parts: [{ text }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.5, maxOutputTokens: 220 }
      })
    },
    timeoutMs,
    "GEMINI"
  );

  if (!response.ok) {
    console.error("Gemini HTTP error:", response.status);
    if (response.status === 401 || response.status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (response.status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  return answer;
}

function errorForUser(error) {
  const code = error?.code || error?.message;
  switch (code) {
    case "MISSING_GEMINI_KEY": return "Сервер не настроен. Проверьте ключ Gemini в Vercel.";
    case "MISSING_SERPER_KEY": return "Поиск пока не настроен. Проверьте ключ Serper в Vercel.";
    case "GEMINI_KEY_REJECTED": return "Не удалось подключиться к Gemini. Проверьте API-ключ.";
    case "GEMINI_QUOTA": return "Превышен лимит запросов к Gemini. Попробуйте позже.";
    case "GEMINI_TIMEOUT":
    case "SERPER_TIMEOUT":
    case "TIME_BUDGET_EXHAUSTED": return "Сервис не успел ответить. Попробуй ещё раз.";
    case "SERPER_REQUEST_FAILED": return "Поиск временно недоступен. Попробуй немного позже.";
    case "GEMINI_BLOCKED": return "Я не смогла обработать этот запрос. Попробуй спросить иначе.";
    case "GEMINI_EMPTY_RESPONSE": return "Нейросеть не вернула ответ. Попробуй задать вопрос иначе.";
    case "GEMINI_REQUEST_FAILED": return "Не удалось связаться с нейросетью. Попробуй позже.";
    default: return "Не получилось обработать запрос. Попробуй ещё раз.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(
    body?.request?.command ||
    body?.request?.original_utterance ||
    ""
  ).trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  try {
    const followUp = isFollowUp(text);
    const previousQuestion = lastSearchContext(oldHistory);
    const shouldSearch = isSearchIntent(text) ||
      (followUp && Boolean(previousQuestion));

    let answer;
    if (shouldSearch) {
      const searchBudget = Math.min(
        SERPER_TIMEOUT_MS,
        Math.max(0, remainingMs() - RESPONSE_RESERVE_MS)
      );
      if (searchBudget < 300) throw new Error("TIME_BUDGET_EXHAUSTED");

      const query = buildSearchQuery(text, oldHistory);
      console.log("Alice search query:", query);
      const result = await searchWeb(query, searchBudget);
      answer = makeSearchAnswer(result);
    } else {
      const geminiBudget = Math.min(
        GEMINI_TIMEOUT_MS,
        Math.max(0, remainingMs() - RESPONSE_RESERVE_MS)
      );
      answer = await askGemini(text, oldHistory, geminiBudget);
    }

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const code = error?.code ||
      (error?.name === "AbortError" ? "TIME_BUDGET_EXHAUSTED" : error?.message);
    console.warn("Alice webhook returned a fallback response:", code || "UNKNOWN_ERROR");
    return res.status(200).json(aliceResponse(
      errorForUser(error),
      false,
      oldHistory
    ));
  }
}

export {
  aliceResponse,
  fitAliceText,
  isSearchIntent,
  safeHistory,
  makeSearchAnswer,
  isFollowUp,
  buildSearchQuery,
  lastSearchContext
};
