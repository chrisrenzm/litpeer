// Public benchmark loaders for LitPeer. Each loader returns items shaped
//   { id, bench, type, question, options?, letters?, correct?, gold? }
// Data files live in evals/bench/data/ (git-ignored: LitQA2 asks that it never end up
// in training corpora, and BioASQ's licence forbids redistribution).
//
//   LitQA2  - FutureHouse LAB-Bench, 199 public multiple-choice questions whose answers sit
//             in one recent paper. Free on GitHub: `node bench/fetch-litqa2.mjs`.
//   BioASQ  - Task B (biomedical QA over PubMed). Free, but needs a BioASQ account:
//             register at https://participants-area.bioasq.org, download the Task B training
//             set (e.g. training13b.json) and save it as evals/bench/data/bioasq.json.
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "data");
export const INSUFFICIENT = "Insufficient information to answer the question";

// Small seeded RNG so samples and option orders are reproducible.
export function rng(seed) {
  let h = 2166136261 >>> 0;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(arr, seed) {
  const a = [...arr], r = rng(seed);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function loadLitQA2() {
  const file = path.join(DATA_DIR, "litqa2.jsonl");
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}. Run: node bench/fetch-litqa2.mjs`);
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    const q = JSON.parse(line);
    // Options in a fixed per-question random order, plus the "insufficient" option LAB-Bench uses.
    const options = [...shuffle([q.ideal, ...q.distractors], q.id), INSUFFICIENT];
    const letters = options.map((_, i) => String.fromCharCode(65 + i));
    return { id: q.id.slice(0, 8), bench: "litqa2", type: "mc", question: q.question, options, letters, correct: letters[options.indexOf(q.ideal)], sources: q.sources };
  });
}

// BioASQ exact answers come as "yes"/"no", ["name"], [["name","synonym"]] or
// [["item1","syn"],["item2"]] depending on year and type. Normalize to groups of synonyms.
function groups(exact) {
  if (exact == null) return [];
  if (typeof exact === "string") return [[exact]];
  return exact.map((g) => (Array.isArray(g) ? g.map(String) : [String(g)]));
}

export function loadBioASQ(types = ["yesno", "factoid", "list"]) {
  const file = path.join(DATA_DIR, "bioasq.json");
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}. BioASQ needs a free account: register at https://participants-area.bioasq.org, download the Task B training set and save it as ${file}`);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return (data.questions || data)
    .filter((q) => types.includes(q.type))
    .map((q) => ({
      id: String(q.id).slice(-10),
      bench: "bioasq",
      type: q.type,
      question: q.body || q.question,
      gold: q.type === "yesno" ? String(q.exact_answer).toLowerCase().trim() : q.type === "factoid" ? groups(q.exact_answer).flat() : groups(q.exact_answer),
    }));
}

// Reproducible sample. BioASQ is stratified by question type (equal share of each).
export function sample(items, n, seed = 1) {
  if (!n || n >= items.length) return items;
  const byType = {};
  for (const it of items) (byType[it.type] ||= []).push(it);
  const types = Object.keys(byType);
  const out = [];
  types.forEach((t, i) => {
    const k = Math.floor(n / types.length) + (i < n % types.length ? 1 : 0);
    out.push(...shuffle(byType[t], `${seed}:${t}`).slice(0, k));
  });
  return out;
}

// PubMedQA (Jin et al. 2019, MIT licence): yes/no/maybe questions written from PubMed article
// titles; the label is the conclusion of that article's abstract. We use the official 500-question
// test split WITHOUT giving the abstract, so each system has to find the evidence itself.
// Free on GitHub: `node bench/fetch-pubmedqa.mjs`.
export function loadPubMedQA() {
  const file = path.join(DATA_DIR, "pubmedqa.json");
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}. Run: node bench/fetch-pubmedqa.mjs`);
  const { questions, test } = JSON.parse(fs.readFileSync(file, "utf8"));
  return Object.keys(test).map((pmid) => ({ id: pmid, bench: "pubmedqa", type: "ynm", question: questions[pmid].QUESTION, gold: test[pmid], sourcePmid: pmid, year: questions[pmid].YEAR }));
}

export function loadBench(name) {
  if (name === "pubmedqa") return loadPubMedQA();
  if (name === "litqa2") return loadLitQA2();
  if (name === "bioasq") return loadBioASQ();
  throw new Error(`Unknown benchmark ${name} (use litqa2, pubmedqa or bioasq)`);
}
