
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;

// Оставляем запас до ограничения Яндекс Алисы.
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

  if (sentenceEnd >= 250) {
    return candidate.slice(0, sentenceEnd + 1).trim();
  }

  const lastSpace = candidate.lastIndexOf(" ");

  return (
    (lastSpace > 200
      ? candidate.slice(0, lastSpace)
      : candidate) + "…"
  );
}

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
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

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные|происходит|произошл|случил|событи|обстановк|в городе|что в [а-яё-]+/i.test(text);
}

async function fetchJson(url, options, timeoutMs, stage) {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(100, timeoutMs));

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

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

// Поиск сразу превращаем в голосовой ответ.
// Второй запрос к Gemini для новостей не выполняется.
async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;

  if (!key) {
    throw new Error("MISSING_SERPER_KEY");
  }

  const { response, data } = await fetchJson(
    "https://google.serper.dev/search",
    {
      method: "POST",
      headers: {
        "X-API-KEY": key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        q: query,
        gl: "ru",
        hl: "ru",
        num: 4
      })
    },
    timeoutMs,
    "SERPER"
  );

  if (!response.ok) {
    console.warn("Serper HTTP error:", response.status);
    throw new Error("SERPER_REQUEST_FAILED");
  }

  const organic = Array.isArray(data.organic)
    ? data.organic
    : [];

  const answerBox =
    data.answerBox?.answer ||
    data.answerBox?.snippet ||
    "";

  const snippets = organic
    .slice(0, 3)
    .map(item => ({
      title: String(item.title || "").trim(),
      snippet: String(item.snippet || "").trim()
    }))
    .filter(item => item.title || item.snippet);

  return { answerBox, snippets };
}

function makeSearchAnswer(result) {
  if (result.answerBox) {
    return fitAliceText(result.answerBox);
  }

  if (!result.snippets.length) {
    return "По этому запросу не удалось найти подходящие результаты. Попробуй сформулировать вопрос иначе.";
  }

  const parts = result.snippets
    .slice(0, 2)
    .map(item => {
      const text = item.snippet || item.title;
      return text.replace(/\s+/g, " ").trim();
    });

  return fitAliceText(
    "Вот что удалось найти. " + parts.join(" ")
  );
}

async function askGemini(text, history, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error("MISSING_GEMINI_KEY");
  }

  if (timeoutMs < 250) {
    throw new Error("TIME_BUDGET_EXHAUSTED");
  }

  const model = String(
    process.env.GEMINI_MODEL || DEFAULT_MODEL
  ).trim();

  if (!/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new Error("INVALID_MODEL_NAME");
  }

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  contents.push({
    role: "user",
    parts: [{ text }]
  });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        contents,
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 220
        }
      })
    },
    timeoutMs,
    "GEMINI"
  );

  if (!response.ok) {
    console.error("Gemini HTTP error:", response.status);

    if (response.status === 401 || response.status === 403) {
      throw new Error("GEMINI_KEY_REJECTED");
    }

    if (response.status === 429) {
      throw new Error("GEMINI_QUOTA");
    }

    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];

  const answer = (candidate?.content?.parts || [])
    .map(part =>
      typeof part.text === "string" ? part.text : ""
    )
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) {
      throw new Error("GEMINI_BLOCKED");
    }

    throw new Error("GEMINI_EMPTY_RESPONSE");
  }

  return answer;
}

function errorForUser(error) {
  const code = error?.code || error?.message;

  switch (code) {
    case "MISSING_GEMINI_KEY":
      return "Сервер не настроен. Проверьте ключ Gemini в Vercel.";

    case "MISSING_SERPER_KEY":
      return "Поиск пока не настроен. Проверьте ключ Serper в Vercel.";

    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ.";

    case "GEMINI_QUOTA":
      return "Превышен лимит запросов к Gemini. Попробуйте позже.";

    case "GEMINI_TIMEOUT":
    case "SERPER_TIMEOUT":
    case "TIME_BUDGET_EXHAUSTED":
      return "Сервис не успел ответить. Попробуй ещё раз.";

    case "SERPER_REQUEST_FAILED":
      return "Поиск временно недоступен. Попробуй немного позже.";

    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуй спросить иначе.";

    case "GEMINI_EMPTY_RESPONSE":
      return "Нейросеть не вернула ответ. Попробуй задать вопрос иначе.";

    case "GEMINI_REQUEST_FAILED":
      return "Не удалось связаться с нейросетью. Попробуй позже.";

    default:
      return "Не получилось обработать запрос. Попробуй ещё раз.";
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

    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const startedAt = Date.now();

  const remainingMs = () =>
    TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);

  const body = req.body && typeof req.body === "object"
    ? req.body
    : {};

  const text = String(
    body?.request?.command ||
    body?.request?.original_utterance ||
    ""
  ).trim();

  const oldHistory = safeHistory(
    body?.state?.session?.history
  );

  if (!text) {
    return res.status(200).json(
      aliceResponse(
        "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
        false,
        oldHistory
      )
    );
  }

  try {
    let answer;

    if (isSearchIntent(text)) {
      // Актуальные вопросы: только Serper.
      // Не ждём дополнительный запрос к Gemini.
      const searchBudget = Math.min(
        SERPER_TIMEOUT_MS,
        Math.max(0, remainingMs() - RESPONSE_RESERVE_MS)
      );

      if (searchBudget < 300) {
        throw new Error("TIME_BUDGET_EXHAUSTED");
      }

      const result = await searchWeb(text, searchBudget);
      answer = makeSearchAnswer(result);

    } else {
      // Обычные вопросы: Gemini.
      const geminiBudget = Math.min(
        GEMINI_TIMEOUT_MS,
        Math.max(0, remainingMs() - RESPONSE_RESERVE_MS)
      );

      answer = await askGemini(
        text,
        oldHistory,
        geminiBudget
      );
    }

    const history = [
      ...oldHistory,
      {
        role: "user",
        text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS)
      },
      {
        role: "model",
        text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS)
      }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(
      aliceResponse(answer, false, history)
    );

  } catch (error) {
    const code =
      error?.code ||
      (error?.name === "AbortError"
        ? "TIME_BUDGET_EXHAUSTED"
        : error?.message);

    console.warn(
      "Alice webhook returned a fallback response:",
      code || "UNKNOWN_ERROR"
    );

    return res.status(200).json(
      aliceResponse(
        errorForUser(error),
        false,
        oldHistory
      )
    );
  }
}

export {
  aliceResponse,
  fitAliceText,
  isSearchIntent,
  safeHistory,
  makeSearchAnswer
};
