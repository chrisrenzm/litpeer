// Turns a system's prose answer into a benchmark answer with one cheap DeepSeek call
// (the same call for every system), then scores it by exact match. No LLM judge.
import { chatJSON } from "../../lib/llm.js";
import { INSUFFICIENT } from "./datasets.mjs";

// The question text each system receives. LitQA2 is multiple choice by design
// (LAB-Bench shows the options, incl. "insufficient information"), so the options are part of it.
export function promptFor(item) {
  if (item.bench === "litqa2") return `${item.question}\n\nOptions:\n${item.options.map((o, i) => `${item.letters[i]}. ${o}`).join("\n")}`;
  return item.question;
}

const RULE = "Use ONLY what the answer text says. Do not use your own knowledge, even if you know the answer.";

export async function extract(item, answerText) {
  const answer = String(answerText || "").slice(0, 12000) || "(empty answer)";
  if (item.bench === "litqa2") {
    const out = await chatJSON({
      system: `You read a research assistant's answer to a multiple-choice question and record which option it chose. ${RULE} If the answer does not clearly commit to exactly one option, or says the evidence is missing, choose the "${INSUFFICIENT}" option. Reply in JSON: {"letter":"A"}`,
      user: `Question:\n${promptFor(item)}\n\nAssistant's answer:\n${answer}`,
      temperature: 0,
      maxTokens: 50,
    });
    const letter = String(out.letter || "").trim().toUpperCase().slice(0, 1);
    return { letter: item.letters.includes(letter) ? letter : item.letters.at(-1) };
  }
  if (item.type === "yesno") {
    const out = await chatJSON({
      system: `You read a research assistant's answer to a yes/no question and record its verdict. ${RULE} Reply in JSON: {"verdict":"yes" | "no" | "unclear"}`,
      user: `Question: ${item.question}\n\nAssistant's answer:\n${answer}`,
      temperature: 0,
      maxTokens: 30,
    });
    return { verdict: ["yes", "no"].includes(String(out.verdict).toLowerCase()) ? String(out.verdict).toLowerCase() : "unclear" };
  }
  const isList = item.type === "list";
  const out = await chatJSON({
    system: `You read a research assistant's answer to a biomedical ${isList ? "list" : "factoid"} question and copy out its answer as short entity names (a gene, drug, disease, number etc., 1-5 words each, no explanation). ${RULE} ${isList ? "List every item the answer gives, up to 20." : "Give the answer's main answer first, then up to 4 alternatives it also names, best first."} If it gives none, return an empty list. Reply in JSON: {"entities":["..."]}`,
    user: `Question: ${item.question}\n\nAssistant's answer:\n${answer}`,
    temperature: 0,
    maxTokens: 300,
  });
  return { entities: (out.entities || []).map(String).slice(0, isList ? 20 : 5) };
}

const norm = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\b(the|a|an)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const same = (a, b) => norm(a) === norm(b);

// Returns per-item metrics; report.mjs averages them.
export function score(item, ext) {
  if (item.bench === "litqa2") {
    const answered = ext.letter !== item.letters.at(-1);
    return { correct: ext.letter === item.correct ? 1 : 0, answered: answered ? 1 : 0 };
  }
  if (item.type === "yesno") return { correct: ext.verdict === item.gold ? 1 : 0, answered: ext.verdict === "unclear" ? 0 : 1 };
  if (item.type === "factoid") {
    const rank = ext.entities.findIndex((e) => item.gold.some((g) => same(e, g)));
    return { correct: rank === 0 ? 1 : 0, lenient: rank >= 0 ? 1 : 0, mrr: rank >= 0 ? 1 / (rank + 1) : 0, answered: ext.entities.length ? 1 : 0 };
  }
  // list: precision / recall / F1 over gold items (each gold item is a group of synonyms)
  const hits = item.gold.filter((grp) => ext.entities.some((e) => grp.some((g) => same(e, g)))).length;
  const tp = ext.entities.filter((e) => item.gold.some((grp) => grp.some((g) => same(e, g)))).length;
  const p = ext.entities.length ? tp / ext.entities.length : 0;
  const r = item.gold.length ? hits / item.gold.length : 0;
  return { precision: p, recall: r, f1: p + r ? (2 * p * r) / (p + r) : 0, answered: ext.entities.length ? 1 : 0 };
}
