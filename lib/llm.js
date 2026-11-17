// Minimal client for DeepSeek's OpenAI-compatible chat API.
// The key is read from the environment and is never logged.

import { runSignal, throwIfStopped } from "./abort.js";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

// Optional token accounting (used by the benchmark runner): run code inside
// trackUsage() and every DeepSeek call made under it adds its usage to the tally.
const usageContext = new AsyncLocalStorage();
export async function trackUsage(fn) {
  const tally = { calls: 0, prompt_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 };
  const result = await usageContext.run(tally, fn);
  return { result, usage: tally };
}
function addUsage(u) {
  const t = usageContext.getStore();
  if (!t || !u) return;
  t.calls++;
  t.prompt_tokens += u.prompt_tokens || 0;
  t.cache_hit_tokens += u.prompt_cache_hit_tokens || 0;
  t.cache_miss_tokens += u.prompt_cache_miss_tokens ?? u.prompt_tokens ?? 0;
  t.completion_tokens += u.completion_tokens || 0;
  t.reasoning_tokens += u.completion_tokens_details?.reasoning_tokens || 0;
}

// Optional backend for evals: LITPEER_LLM=claude runs every call through the local
// Claude Code CLI (`claude -p`, model from LITPEER_CLAUDE_MODEL, default sonnet), which
// uses the signed-in Claude account instead of a DeepSeek key. The app itself keeps DeepSeek.
const USE_CLAUDE = process.env.LITPEER_LLM === "claude";
const CLAUDE_MODEL = process.env.LITPEER_CLAUDE_MODEL || "sonnet";
const CLAUDE_MAX = Number(process.env.LITPEER_CLAUDE_CONC || 6);
let claudeActive = 0;
const claudeQueue = [];
let emptyDir = null;
async function claudeOnce({ system, user }) {
  if (claudeActive >= CLAUDE_MAX) await new Promise((r) => claudeQueue.push(r));
  claudeActive++;
  try {
    emptyDir ||= mkdtempSync(join(tmpdir(), "litpeer-claude-"));
    const text = await new Promise((resolve, reject) => {
      const p = spawn("claude", ["-p", "--model", CLAUDE_MODEL, "--output-format", "text", "--system-prompt", system + "\nReply with only the JSON object, no other text.", "--tools", "", "--strict-mcp-config", "--no-session-persistence"], { cwd: emptyDir, stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      const t = setTimeout(() => p.kill("SIGKILL"), 240000);
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(`claude CLI exit ${code}: ${(err || out).slice(0, 300)}`)); });
      p.stdin.end(user);
    });
    return parseLoose(text);
  } finally {
    claudeActive--;
    claudeQueue.shift()?.();
  }
}

const BASE = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

export function hasKey() {
  return USE_CLAUDE || Boolean(process.env.DEEPSEEK_API_KEY);
}

async function callOnce({ system, user, temperature, maxTokens }) {
  throwIfStopped();
  if (USE_CLAUDE) return claudeOnce({ system, user });
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
  addUsage(data?.usage);
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
