// Minimal client for DeepSeek's OpenAI-compatible chat API.
// The key is read from the environment and is never logged.

import { runSignal, throwIfStopped } from "./abort.js";

const BASE = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

export function hasKey() {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}

async function callOnce({ system, user, temperature, maxTokens }) {
  throwIfStopped();
  if (process.env.LITPEER_DEBUG) console.log(`[LitPeer] LLM call ${new Date().toISOString()}`);
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    signal: runSignal() || undefined,
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`DeepSeek API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  return parseLoose(text);
}

// Parse model output as JSON, tolerating code fences or text around the object.
function parseLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("Model returned malformed JSON");
  }
}

// Ask for a JSON object. Retries up to 2 more times if the call or the JSON parse fails
// (the model occasionally returns broken JSON), nudging the temperature each time.
export async function chatJSON({ system, user, temperature = 0.2, maxTokens = 2500 }) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await callOnce({
        system: attempt ? system + "\nReturn strictly valid JSON: escape any double quotes inside strings." : system,
        user,
        temperature: Math.min(1, temperature + attempt * 0.15),
        maxTokens,
      });
    } catch (err) {
      lastErr = err;
      if (err.name === "AbortError" || runSignal()?.aborted) throw err; // stopped by the user
      if (/ 40[0-3]/.test(String(err.message))) throw err; // bad key / bad request: don't retry
    }
  }
  throw lastErr;
}
