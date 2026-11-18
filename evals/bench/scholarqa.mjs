// ScholarQABench-Bio (OpenScholar, Asai et al. 2024): 1,451 open-ended biomedical literature
// questions written by PhD-level experts. There are no reference answers; the official metric for
// this subset is citation accuracy:
//   citation recall    = share of answer sentences (>= 50 chars) that are fully supported by the
//                        papers they cite (a sentence without citations inherits the previous one's;
//                        a sentence with none at all counts as unsupported)
//   citation precision = share of citations that are needed (for sentences with several citations,
//                        a citation that supports nothing the others don't is "overcitation")
// The official script judges support with an NLI model (osunlp/attrscore-flan-t5-xl). That needs a
// GPU and Hugging Face, which this environment doesn't have, so the SAME prompt and rules are
// applied with DeepSeek as the judge. The judge sees each cited paper's real PubMed abstract plus its
// free PMC full-text Results when available; a citation that can't be found in PubMed has no text,
// so anything resting on it counts as unsupported.
//
// Usage (from evals/):
//   node bench/fetch-scholarqa.mjs                                     (once)
//   node --import ./json-loader.mjs bench/scholarqa.mjs --n 50 [--seed 1] [--systems ...] [--out scholarqa-bio-n50]
// Resumable. Writes results/bench/<out>/{answers,judged}/ and summary.md.
import fs from "node:fs";
import path from "node:path";
import { SYSTEMS } from "../systems.mjs";
import { chatJSON, trackUsage } from "../../lib/llm.js";
import { pubmedSearch, pubmedFetch, pmcFullText } from "../../lib/acquire.js";
import { DATA_DIR, shuffle } from "./datasets.mjs";
import { PRICES, cost } from "./prices.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const n = Number(arg("n", 50));
const seed = arg("seed", "1");
const systems = arg("systems", "litpeer,llm_only,rag_simple").split(",");
const CONC = Number(arg("conc", 3));
const outName = arg("out", `scholarqa-bio-n${n}`);
const base = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "results", "bench", outName);
const ansDir = path.join(base, "answers"), judgedDir = path.join(base, "judged");
fs.mkdirSync(ansDir, { recursive: true });
fs.mkdirSync(judgedDir, { recursive: true });

const file = path.join(DATA_DIR, "scholarqa_bio.jsonl");
if (!fs.existsSync(file)) throw new Error(`Missing ${file}. Run: node bench/fetch-scholarqa.mjs`);
const all = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const items = shuffle(all, `scholarqa:${seed}`).slice(0, n);
fs.writeFileSync(path.join(base, "sample.json"), JSON.stringify({ n, seed, ids: items.map((i) => i.id) }, null, 1));

async function pool(jobs, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: CONC }, async () => { while (next < jobs.length) await fn(jobs[next++]); }));
}

// ---------- 1. answers ----------
const jobs = [];
for (const it of items) for (const s of systems) jobs.push({ it, s });
const aFile = (j) => path.join(ansDir, `${j.s}__${j.it.id}.json`);
const todo = jobs.filter((j) => !fs.existsSync(aFile(j)));
console.log(`answers: ${todo.length} of ${jobs.length} to do`);
let done = 0;
await pool(todo, async (j) => {
  const t0 = Date.now();
  try {
    const r = await trackUsage(() => SYSTEMS[j.s](j.it.input));
    fs.writeFileSync(aFile(j), JSON.stringify({ system: j.s, id: j.it.id, question: j.it.input, seconds: Math.round((Date.now() - t0) / 1000), answer: r.result.text, references: r.result.references, usage: r.usage }, null, 1));
    console.log(`[${++done}/${todo.length}] ${j.s} ${j.it.id} ok ${r.result.references.length} refs`);
  } catch (e) {
    console.log(`[${++done}/${todo.length}] ${j.s} ${j.it.id} FAILED: ${e.message}`);
  }
});

// ---------- 2. look up each cited paper ----------
const cachePath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "results", "pubmed-cache.json");
const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};
const saveCache = () => fs.writeFileSync(cachePath, JSON.stringify(cache));
const words = (s) => new Set(String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
const titleSim = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let k = 0; for (const w of A) if (B.has(w)) k++; return k / Math.max(A.size, B.size); };
async function byPmid(id) {
  const k = `pmid:${id}`;
  if (!(k in cache)) { cache[k] = (await pubmedFetch([String(id)]).catch(() => []))[0] || null; saveCache(); }
  return cache[k];
}
async function search(term) {
  const k = `search:${term}`;
  if (!(k in cache)) { cache[k] = (await pubmedSearch(term, 3).catch(() => ({ ids: [] }))).ids; saveCache(); }
  return cache[k];
}
async function fullResults(rec) {
  if (!rec?.pmcid) return "";
  const k = `pmcres:${rec.pmcid}`;
  if (!(k in cache)) { cache[k] = (await pmcFullText(rec.pmcid).catch(() => null))?.results || ""; saveCache(); }
  return cache[k];
}
// The real paper behind a reference (title must match), or null.
async function resolve(ref) {
  if (ref.pmid) { const r = await byPmid(ref.pmid); if (r && (!ref.title || titleSim(ref.title, r.title) >= 0.5)) return r; }
  const tries = [];
  if (ref.doi) tries.push(`${ref.doi}[doi]`);
  if (ref.title) tries.push(`${String(ref.title).replace(/[\[\]():"]/g, " ")}[title]`);
  for (const t of tries) {
    for (const id of await search(t)) { const r = await byPmid(id); if (r && (!ref.title || titleSim(ref.title, r.title) >= 0.5)) return r; }
  }
  return null;
}
async function docText(ref) {
  const rec = await resolve(ref);
  if (!rec) return null;
  const res = await fullResults(rec);
  return `Title: ${rec.title}\n${rec.abstract}${res ? `\nRESULTS (full text excerpt): ${res.slice(0, 3000)}` : ""}`;
}

// ---------- 3. official-style citation recall / precision ----------
// Prompt copied from ScholarQABench scripts/citation_correctness_eval.py (AttrScore).
const ATTR = "As an Attribution Validator, your task is to verify whether a given reference can support the given claim. A claim can be either a plain sentence or a question followed by its answer. Specifically, your response should clearly indicate the relationship: Attributable, Contradictory or Extrapolatory. A contradictory error occurs when you can infer that the answer contradicts the fact presented in the context, while an extrapolatory error means that you cannot infer the correctness of the answer based on the information provided in the context.";
async function attributable(passage, claim) {
  if (!passage.trim()) return 0;
  const out = await chatJSON({ system: `${ATTR}\nReply in JSON: {"relationship":"Attributable" | "Contradictory" | "Extrapolatory"}`, user: `Claim: ${claim}\n Reference: ${passage}`, temperature: 0, maxTokens: 30 });
  return /^attributable/i.test(String(out.relationship || "")) ? 1 : 0;
}
const CITE = /\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g;
const citesOf = (s) => [...s.matchAll(CITE)].flatMap((m) => m[1].split(/\s*,\s*/).flatMap((p) => { const [a, b] = p.split(/\s*[–-]\s*/).map(Number); return b ? Array.from({ length: Math.min(b - a + 1, 20) }, (_, i) => a + i) : [a]; }));
const strip = (s) => s.replace(CITE, "").replace(/\s{2,}/g, " ").replace(/ ([.,;])/g, "$1").trim();
// Sentences: split prose on sentence ends; markdown headings are not sentences.
function sentences(text) {
  return String(text).split("\n").map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").replace(/\*\*/g, "")).filter((l) => l.trim() && !/^\s*#/.test(l))
    .flatMap((l) => l.split(/(?<=[.!?](?:\s*\[[\d,\s–-]+\])*)\s+(?=[A-Z(])/));
}

async function judge(rec) {
  const docs = {};
  for (const r of rec.references) docs[Number(r.n)] = await docText(r).catch(() => null);
  let total = 0, entail = 0, entailPrec = 0, citations = 0, prev = null;
  const log = [];
  for (const sent of sentences(rec.answer)) {
    if (sent.length < 50) continue;
    total++;
    let ref = [...new Set(citesOf(sent))];
    if (!ref.length && prev) ref = prev;
    let ok = 0;
    if (ref.length) {
      prev = ref;
      citations += ref.length;
      const joint = ref.map((i) => docs[i]).filter(Boolean).join("\n");
      ok = await attributable(joint, strip(sent));
      if (ok && ref.length > 1) {
        for (const id of ref) {
          let need = docs[id] ? await attributable(docs[id], strip(sent)) : 0;
          if (!need) {
            const others = ref.filter((x) => x !== id).map((x) => docs[x]).filter(Boolean).join("\n");
            need = (await attributable(others, strip(sent))) ? 0 : 1; // others alone suffice -> this one was not needed
          }
          entailPrec += need;
        }
      } else entailPrec += ok * ref.length;
    }
    entail += ok;
    log.push({ sentence: strip(sent), cites: ref, supported: ok });
  }
  const found = Object.values(docs).filter(Boolean).length;
  return {
    sentences: total,
    citation_recall: total ? entail / total : 0,
    citation_precision: citations ? entailPrec / citations : 0,
    references: rec.references.length,
    references_found_in_pubmed: found,
    log,
  };
}

const answers = fs.readdirSync(ansDir).map((f) => JSON.parse(fs.readFileSync(path.join(ansDir, f), "utf8")));
const toJudge = answers.filter((a) => !fs.existsSync(path.join(judgedDir, `${a.system}__${a.id}.json`)));
console.log(`judging: ${toJudge.length} of ${answers.length} to do`);
done = 0;
await pool(toJudge, async (a) => {
  try {
    const j = await trackUsage(() => judge(a));
    fs.writeFileSync(path.join(judgedDir, `${a.system}__${a.id}.json`), JSON.stringify({ ...j.result, judge_usage: j.usage }, null, 1));
    console.log(`[${++done}/${toJudge.length}] judged ${a.system} ${a.id}: recall ${j.result.citation_recall.toFixed(2)}, precision ${j.result.citation_precision.toFixed(2)}`);
  } catch (e) {
    console.log(`[${++done}/${toJudge.length}] judge ${a.system} ${a.id} FAILED: ${e.message}`);
  }
});

// ---------- 4. summary ----------
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const pct = (x) => (isNaN(x) ? "–" : `${Math.round(x * 100)}%`);
const lines = [`# ScholarQABench-Bio: ${outName}`, "", `${items.length} questions, sampled with seed ${seed} from 1,451. Citation recall/precision follow ScholarQABench's official rules; the judge is DeepSeek with the official AttrScore prompt instead of the T5 NLI model.`, "", "| System | Answers | Citation recall (sentences supported by their citations) | Citation precision | Citations per answer | Cited papers found in PubMed | Sentences per answer | Median seconds |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
const costLines = ["", "## Cost per question (measured)", "", "| System | Answer $ off-peak / peak | Judge $ off-peak / peak |", "| --- | --- | --- |"];
for (const s of systems) {
  const as = answers.filter((a) => a.system === s);
  const js = as.map((a) => { const f = path.join(judgedDir, `${s}__${a.id}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; }).filter(Boolean);
  if (!as.length) continue;
  const secs = as.map((a) => a.seconds).sort((x, y) => x - y)[Math.floor(as.length / 2)];
  const found = js.reduce((t, j) => t + j.references_found_in_pubmed, 0), refs = js.reduce((t, j) => t + j.references, 0);
  lines.push(`| ${s} | ${js.length} | ${pct(mean(js.map((j) => j.citation_recall)))} | ${pct(mean(js.map((j) => j.citation_precision)))} | ${mean(js.map((j) => j.references)).toFixed(1)} | ${pct(refs ? found / refs : NaN)} | ${mean(js.map((j) => j.sentences)).toFixed(1)} | ${secs} |`);
  const avg = (us) => Object.fromEntries(Object.keys(us[0] || { calls: 0 }).map((k) => [k, mean(us.map((u) => u[k] || 0))]));
  const au = avg(as.map((a) => a.usage)), ju = avg(js.map((j) => j.judge_usage));
  costLines.push(`| ${s} | $${cost(au, PRICES["flash-offpeak"]).toFixed(4)} / $${cost(au, PRICES["flash-peak"]).toFixed(4)} | $${cost(ju, PRICES["flash-offpeak"]).toFixed(4)} / $${cost(ju, PRICES["flash-peak"]).toFixed(4)} |`);
}
const md = [...lines, ...costLines].join("\n") + "\n";
fs.writeFileSync(path.join(base, "summary.md"), md);
console.log(md);
