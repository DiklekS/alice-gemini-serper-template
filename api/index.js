const DEFAULT_MODEL = "gemini-3.5-flash-lite";

const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 700;
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

function isNewsDetailFollowUp(text, history) {
  const value = String(text || "").trim().toLowerCase().replace(/ё/g, "е");
  const hasNewsContext = Boolean(lastSearchContext(history));
  if (!hasNewsContext || value.length < 8) return false;
  return /(?:расскажи|объясни|поясни|подробн|детал|что известно|что случилось|что произошло|последств|подробнее про|подробнее об|про беспилот|об атаке|о беспилот|по поводу)/i.test(value);
}

function lastAssistantSearchAnswer(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item.role === "model" && /вот что происходит|вот конкретные новости|вот что удалось найти/i.test(item.text)) {
      return item.text;
    }
  }
  return "";
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
  const query = String(text || "").trim();

  // If the user names a subject after hearing the news digest, search that
  // subject directly instead of repeating the broad city-news query.
  if (isNewsDetailFollowUp(query, history)) {
    const isDroneTopic = /беспилот|бпла|дрон|авиационн|сирен|атаке/i.test(query);
    const city = /\bомск/i.test(previous) || isDroneTopic ? "Омск" : "";
    const answerContext = lastAssistantSearchAnswer(history);
    const relevantHeadline = answerContext
      .split(/Ещё событие:|\.\s*/)
      .map(part => part.replace(/^вот что происходит в омске\.?\s*/i, "").trim())
      .find(part => part.length > 20 && (!isDroneTopic || /беспилот|бпла|дрон|сирен|атак/i.test(part)));
    const topic = isDroneTopic ? "беспилотная опасность атака БПЛА" : query;
    return [city, topic, relevantHeadline, "последние новости Омск подробности after:2026-11-03 -карта -мониторинг -Петербург"]
      .filter(Boolean).join(" ");
  }

  if (isFollowUp(query) && previous) {
    const lastAnswer = lastAssistantSearchAnswer(history);
    const subject = lastAnswer
      .replace(/^вот что происходит в омске\.?\s*/i, "")
      .replace(/^вот конкретные новости\.?\s*/i, "")
      .slice(0, 260);
    return [previous, subject, "подробности новости"].filter(Boolean).join(" ");
  }

  if (/что происходит|что случилось|что произошло/i.test(query)) {
    return query + " последние новости конкретные события сегодня after:2026-11-03";
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
      snippet: String(item.snippet || "").trim(),
      date: String(item.date || item.datePublished || "").trim()
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
  // Search sometimes returns social-channel names as if they were news headlines.
  if (/@[a-z0-9_]{2,}|telegram|телеграм|путеводитель.*для местных/i.test(value)) return false;

  const genericPatterns = [
    /^новости\b/i,
    /^(?:омск\s*[-—:]?\s*)?главные новости/i,
    /^(?:чп\s*омск|омск-информ|бк\s*55|бк55)\b/i,
    /^действия\.?$/i,
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

function isRecentNewsItem(item) {
  const source = [
    String(item?.date || ""),
    String(item?.title || ""),
    String(item?.snippet || "")
  ].join(" ").toLowerCase().replace(/ё/g, "е");
  const now = new Date();
  let published = null;

  const relative = source.match(/(\d+)\s*(часов|часа|час|минут|минута|минуты|дней|дня|день|дн)\s*назад|(вчера|сегодня)|\b(\d+)\s*(hours?|minutes?|days?)\s+ago\b|\b(today|yesterday)\b/i);
  if (relative) {
    if (relative[2]) {
      const amount = Number(relative[1]);
      const unit = relative[2];
      published = new Date(now.getTime() - amount * (/час/.test(unit) ? 3600000 : /минут/.test(unit) ? 60000 : 86400000));
    } else if (relative[4]) {
      const amount = Number(relative[4]);
      const unit = relative[5];
      published = new Date(now.getTime() - amount * (/hour/.test(unit) ? 3600000 : /minute/.test(unit) ? 60000 : 86400000));
    } else {
      published = new Date(now);
      if (relative[3] === "вчера" || relative[6] === "yesterday") published.setDate(published.getDate() - 1);
    }
  }

  if (!published) {
    const monthNames = {
      "января": 0, "февраля": 1, "марта": 2, "апреля": 3,
      "мая": 4, "июня": 5, "июля": 6, "августа": 7,
      "сентября": 8, "октября": 9, "ноября": 10, "декабря": 11
    };
    const dated = source.match(/(?:^|\s)(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(20\d{2}))?(?=\s|$)/i);
    if (dated) {
      const year = dated[3] ? Number(dated[3]) : now.getFullYear();
      published = new Date(year, monthNames[dated[2]], Number(dated[1]), 12, 0, 0);
    }
  }

  if (!published) {
    const parsed = Date.parse(String(item?.date || ""));
    if (Number.isFinite(parsed)) published = new Date(parsed);
  }

  if (!published || Number.isNaN(published.getTime())) return false;
  const ageMs = now.getTime() - published.getTime();
  return ageMs >= -86400000 && ageMs <= 7 * 86400000;
}

function isRelevantDetailedResult(item) {
  const title = String(item?.title || "");
  const snippet = String(item?.snippet || "");
  const combined = (title + " " + snippet).toLowerCase().replace(/ё/g, "е");

  if (!isRecentNewsItem(item)) return false;
  // The headline itself must identify Omsk; a snippet mentioning Omsk is not enough.
  if (!/(омск|омской|омске|омич|хоценко)/i.test(title)) return false;
  if (/(соседн.*регион|тюменск|новосибирск|курганск)/i.test(title)) return false;
  if (/(карта\s*бпла|мониторинг воздушной|воздушной обстановк|активных:\s*\d+|все регионы)/i.test(combined)) return false;
  if (/(санкт-петербург|петербург|ленинградск)/i.test(combined)) return false;
  if (!/(беспилот|бпла|дрон|сирен|пво|авиационн|ограничени.*связ|атак)/i.test(combined)) return false;
  return true;
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

function mentionsOlderCalendarDate(value) {
  const source = String(value || "").toLowerCase().replace(/ё/g, "е");
  const months = {
    "января": 0, "февраля": 1, "марта": 2, "апреля": 3,
    "мая": 4, "июня": 5, "июля": 6, "августа": 7,
    "сентября": 8, "октября": 9, "ноября": 10, "декабря": 11
  };
  const match = source.match(/(?:^|\s)(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(20\d{2}))?(?=\s|$)/i);
  if (!match) return false;
  const now = new Date();
  const year = match[3] ? Number(match[3]) : now.getFullYear();
  const eventDay = Date.UTC(year, months[match[2]], Number(match[1]));
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return eventDay < today;
}

function makeSearchAnswer(result, detailed = false, todayOnly = false) {
  const seen = new Set();
  const raw = Array.isArray(result.snippets) ? result.snippets : [];
  console.info("Serper organic results:", JSON.stringify(raw.slice(0, 8).map(item => ({
    title: item.title,
    date: item.date,
    snippet: String(item.snippet || "").slice(0, 220)
  }))));

  if (detailed) {
    const details = [];
    for (const item of raw) {
      const title = cleanNewsTitle(item.title);
      const snippet = String(item.snippet || "")
        .replace(/https?:\/\/\S+/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      const isFeed = /[·•]\s*(?:\d{1,2}:\d{2}|[«"А-ЯЁ])/u.test(snippet) ||
        /\b\d{1,2}:\d{2}\b/.test(snippet);
      if (!isRelevantDetailedResult(item) || !isUsefulNewsTitle(title) || title.length < 18 || isFeed) continue;
      const key = title.toLocaleLowerCase("ru").replace(/[«»"']/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
      const description = snippet.length >= 45 && snippet.length <= 420 ? snippet : "";
      details.push(description ? title + ". " + description : title);
      if (details.length >= 3) break;
    }

    if (details.length) {
      return fitAliceText("Вот что удалось найти подробнее. " + details.join(". "));
    }
  }

  const headlines = [];
  const addHeadline = value => {
    const headline = String(value || "")
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/^\s*\d{1,2}:\d{2}\s*/, "")
      .replace(/\s+/g, " ")
      .replace(/[.…]{2,}\s*$/g, "")
      .replace(/[.!?;:,]+$/g, "")
      .trim();

    if (
      (todayOnly && mentionsOlderCalendarDate(headline)) ||
      headline.length < 18 ||
      headline.length > 170 ||
      !isUsefulNewsTitle(headline) ||
      /[.…]{2,}$/.test(String(value || "").trim()) ||
      /\b(?:о|в|и|на|по|из|для|что|как|сообщил|сообщила)\s*$/i.test(headline) ||
      /^(?:что произошло|главные новости|последние новости|новости омска)/i.test(headline) ||
      /^(?:омска?\s+и\s+омской области|омск\s*[-—:]\s*последние новости|последние новости омска)(?:\s+сегодня)?$/i.test(headline) ||
      /^(?:новости омска и омской области|омск\s*[-—:]?\s*последние новости сегодня)$/i.test(headline)
    ) return;

    const key = headline.toLocaleLowerCase("ru").replace(/[«»"']/g, "").trim();
    if (seen.has(key)) return;
    seen.add(key);
    headlines.push(headline);
  };

  for (const item of raw) {
    if (!isRecentNewsItem(item)) continue;
    const rawTitle = String(item.title || "");
    if (/\.{2,}|…/.test(rawTitle)) continue;
    const title = cleanNewsTitle(rawTitle);
    const titleLower = title.toLowerCase().replace(/ё/g, "е");
    const isPortalTitle = /^(?:омск\s*[-—:]?\s*)?(?:главные|последние)?\s*новости\b|^(?:чп\s*омск|омск-информ|бк\s*55|бк55|аив|аиф)\b/i.test(title);
    const itemText = (title + " " + String(item.snippet || "")).toLowerCase().replace(/ё/g, "е");
    const titleHasOmskContext = /(омск|омской|омске|омич|хоценко|иртыш)/i.test(titleLower);
    const hasSpecificTitle = !isPortalTitle &&
      titleHasOmskContext &&
      isUsefulNewsTitle(title) &&
      title.length >= 22 &&
      !/(пермск|пермь|екатеринбург|казан|петербург|ленинградск)/i.test(titleLower);

    if (hasSpecificTitle) {
      addHeadline(title);
    } else {
      const snippet = String(item.snippet || "")
        .replace(/https?:\/\/\S+/gi, "")
        .replace(/^\s*(?:INTERFAX\.RU|ТАСС|РИА НОВОСТИ)\s*[-—:]\s*/i, "")
        .replace(/\s+/g, " ")
        .trim();
      const feedParts = snippet.split(/\s*[·•]\s*/).filter(Boolean);
      const fragments = [];
      for (const part of feedParts) {
        const cleanedPart = part
          .replace(/^\s*\d{1,6}\.?\s*/, "")
          .replace(/^(?:новости за сегодня|новости|эксклюзивы|политика|экономика|происшествия|спорт|читайте также)\s*[.!:—-]?\s*/i, "")
          .trim();
        if (!cleanedPart || /^(?:объект строится|строится в рамках|в рамках проекта|сообщили в|по данным|подробнее на сайте)/i.test(cleanedPart)) continue;
        const sentences = cleanedPart.split(/(?<=[.!?])\s+(?=[А-ЯЁ0-9«"„])/u);
        for (const sentence of sentences) {
          const fragment = sentence.replace(/^[\s\d.:-]+/, "").trim();
          if (fragment.length >= 28) fragments.push(fragment);
        }
      }
      for (const fragment of fragments) {
        const fragmentText = fragment.toLowerCase().replace(/ё/g, "е");
        if (!/(?:в\s+омске|в\s+омской\s+области|омская\s+область|из\s+омска|омич[а-яё]*|хоценко|иртыш|омский\s+аэропорт)/i.test(fragmentText)) continue;
        if (/(пермск|пермь|екатеринбург|казан|петербург|ленинградск)/i.test(fragmentText)) continue;
        if (/^(?:новости|эксклюзивы|политика|экономика|происшествия|спорт|действия)\b/i.test(fragmentText)) continue;
        addHeadline(fragment);
      }
    }
    if (headlines.length >= 6) break;
  }

  const answerBox = cleanNewsTitle(result.answerBox || "");
  if (!headlines.length && answerBox.length > 25 && isUsefulNewsTitle(answerBox)) {
    addHeadline(answerBox);
  }

  if (headlines.length) {
    return fitAliceText(
      "Вот что происходит в Омске: " + headlines.slice(0, 4).join(". ") + "."
    );
  }

  return "Поиск пока не выделил отдельные новости. Попробуй спросить о конкретной теме или районе.";
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
        generationConfig: { temperature: 0.3, maxOutputTokens: 140 }
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
    const detailFollowUp = isNewsDetailFollowUp(text, oldHistory);
    const previousQuestion = lastSearchContext(oldHistory);
    const shouldSearch = isSearchIntent(text) ||
      (followUp && Boolean(previousQuestion)) ||
      detailFollowUp;

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
      answer = makeSearchAnswer(result, detailFollowUp, /сегодня|today/i.test(text));
    } else {
      const geminiBudget = Math.min(
        GEMINI_TIMEOUT_MS,
        Math.max(0, remainingMs() - RESPONSE_RESERVE_MS)
      );
      // A new general question must not inherit a long, unrelated news-search thread.
      // Keep a short conversational tail only when it is not stale search context.
      const geminiHistory = previousQuestion && !followUp && !detailFollowUp
        ? []
        : oldHistory.slice(-6);
      answer = await askGemini(text, geminiHistory, geminiBudget);
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
