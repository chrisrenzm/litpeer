// Grades raw answers.
//  1. Citation check (code): every reference is looked up in PubMed by PMID, DOI or title.
//  2. Claim support (judge model): the answer's factual claims are listed, then each is checked
//     against the cited papers that really exist: abstract plus the free full-text Results section
//     when PubMed Central has one. Same rule for every system.
//  3. Rubric (judge model): accuracy vs the answer key, evidence weighting, handling missing
//     evidence / false premises, staying on the question. 0-2 each. The judge sees an anonymized
//     answer (no system names) and the answer key.
//  4. Consistency across runs: same bottom line (judge) + overlap of cited real papers.
// Usage: node --import ./json-loader.mjs grade.mjs --set practice
import fs from "node:fs";
import path from "node:path";
import { chatJSON } from "../lib/llm.js";
import { pubmedSearch, pubmedFetch, pmcFullText } from "../lib/acquire.js";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const set = arg("set", "practice");
const out = arg("out", set); // results subfolder
const CONC = Number(arg("conc", 6));
const here = path.dirname(new URL(import.meta.url).pathname);
const base = path.join(here, "results", out);
const rawDir = path.join(base, "raw"), gradedDir = path.join(base, "graded");
fs.mkdirSync(gradedDir, { recursive: true });
const Q = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(here, "questions.json")))[set].map((q) => [q.id, q]));

// ---------- 1. citation check ----------
const cachePath = path.join(here, "results", "pubmed-cache.json");
const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath)) : {};
const saveCache = () => fs.writeFileSync(cachePath, JSON.stringify(cache));
const words = (s) => new Set(String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
function titleSim(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}
async function fetchPmids(ids) {
  const need = ids.filter((id) => !(`pmid:${id}` in cache));
  if (need.length) {
    const got = await pubmedFetch(need).catch(() => []);
    for (const id of need) cache[`pmid:${id}`] = got.find((p) => p.pmid === id) || null;
    saveCache();
  }
  return ids.map((id) => cache[`pmid:${id}`]);
}
async function searchIds(term) {
  const k = `search:${term}`;
  if (!(k in cache)) { cache[k] = (await pubmedSearch(term, 3).catch(() => ({ ids: [] }))).ids; saveCache(); }
  return cache[k];
}
// Hosts that publish research papers. A reference that is only a URL on another host
// (FDA label, news story, company page) is counted as a "web" source, not checked in PubMed.
const PAPER_HOSTS = /(nejm|science\.org|nature\.com|springer|sciencedirect|jci\.org|pnas|wiley|neurology\.org|diabetesjournals|mdpi|ncbi\.nlm\.nih|bmj\.com|thelancet|jamanetwork|cell\.com|academic\.oup|frontiersin|tandfonline|ahajournals|biomedcentral|plos|elifesciences|aacrjournals|ascopubs)/i;
function cleanTitle(t) {
  return String(t || "").replace(/\s+[|\-–]\s+[^|\-–]*$/, (m) => (m.length < 40 ? "" : m)).replace(/(\.\.\.|…)\s*$/, "").trim();
}
// exists = a real PubMed record whose title matches the cited title.
async function checkRef(ref) {
  const url = String(ref.url || "");
  const pmcid = (url.match(/PMC\d+/i) || [])[0];
  const pmidFromUrl = (url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/) || [])[1];
  const pmid = ref.pmid || pmidFromUrl;
  if (!ref.title && !pmid && !ref.doi && !pmcid) return { status: "unchecked" };
  if (url && !pmid && !ref.doi && !pmcid && !PAPER_HOSTS.test(url)) return { status: "web" };
  const title = cleanTitle(ref.title);
  const truncated = /(\.\.\.|…)\s*$/.test(String(ref.title || "")) || title !== String(ref.title || "").trim();
  const sim = (a, b) => {
    if (!truncated) return titleSim(a, b);
    const A = words(a), B = words(b);
    let n = 0; for (const w of A) if (B.has(w)) n++;
    return A.size ? n / A.size : 0; // a cut-off title: share of its words found in the real title
  };
  if (pmid) {
    const [rec] = await fetchPmids([String(pmid)]);
    if (rec && (!title || sim(title, rec.title) >= 0.5)) return { status: "exists", via: "pmid", record: rec };
  }
  const tries = [];
  if (pmcid) tries.push(`${pmcid}[pmcid]`);
  if (ref.doi) tries.push(`${ref.doi}[doi]`);
  if (title) tries.push(`${title.replace(/[\[\]():"]/g, " ")}[ti]`);
  for (const t of tries) {
    const ids = await searchIds(t);
    const recs = (await fetchPmids(ids)).filter(Boolean);
    const best = recs.map((r) => ({ r, s: title ? sim(title, r.title) : 1 })).sort((a, b) => b.s - a.s)[0];
    const byId = /\[(doi|pmcid)\]$/.test(t);
    if (best && (best.s >= 0.6 || (byId && best.s >= 0.4))) return { status: ref.pmid ? "exists_wrong_id" : "exists", via: t.match(/\[(\w+)\]$/)[1], record: best.r };
  }
  return { status: "not_found" };
}

async function fullResults(rec) {
  if (!rec?.pmcid) return "";
  const k = `pmc:${rec.pmcid}`;
  if (!(k in cache)) { cache[k] = (await pmcFullText(rec.pmcid).catch(() => null))?.results || ""; saveCache(); }
  return cache[k];
}

// ---------- anonymized rendering for the judge ----------
function anon(rec) {
  const refs = rec.references.map((r) => `[${r.n}] ${r.title} (${String(r.authors || "").split(",")[0]}, ${r.year})`).join("\n");
  return `${rec.text.replace(/LitPeer/gi, "the assistant")}\n\nReferences:\n${refs || "(none)"}`;
}

// ---------- 2. claim support ----------
async function claimSupport(rec, checked) {
  const ex = await chatJSON({
    system: `You list the factual scientific claims in an answer. A claim is a statement about findings, effects, numbers, mechanisms or what studies show. Skip headings, hedges, advice, and statements that only say evidence is missing or that the assistant could not find something. Merge near-duplicates. List at most 12, in order. For each give the citation numbers attached to it in the answer ([] if none).
Reply in JSON: {"claims":[{"text":"...","citations":[1,2]}]}`,
    user: rec.text,
    temperature: 0,
    maxTokens: 1800,
  });
  const claims = (ex.claims || []).slice(0, 12);
  if (!claims.length) return { claims: [], verdicts: [] };
  const valid = new Map(checked.filter((c) => c.record).map((c) => [Number(c.n), c.record]));
  // Answers copied from web tools lose their inline [n] markers (Perplexity) or use author-year
  // text (Elicit). Then each claim is checked against ALL of the answer's real cited papers
  // ("pooled" mode), which is more lenient than the per-citation check used for the others.
  const pooled = !/\[\d+/.test(rec.text);
  if (pooled) for (const c of claims) c.citations = [...valid.keys()];
  const used = [...new Set(claims.flatMap((c) => (c.citations || []).map(Number)).filter((n) => valid.has(n)))];
  const src = (await Promise.all(used.map(async (n) => {
    const r = valid.get(n);
    const full = await fullResults(r);
    return `[${n}] ${r.title} (${r.year})\nABSTRACT: ${r.abstract}${full ? `\nRESULTS (free full text): ${full.slice(0, 3000)}` : ""}`;
  }))).join("\n\n");
  const list = claims.map((c, i) => `${i + 1}. ${c.text} -- cites: ${(c.citations || []).map(Number).filter((n) => valid.has(n)).join(", ") || "nothing valid"}`).join("\n");
  const v = await chatJSON({
    system: `You are a strict fact-checker. For each numbered claim, decide whether the text of the papers it cites (if a claim lists many papers, it is supported if any of them supports it) (abstract, plus full-text results when given) supports it.
- "supported": the cited text clearly states it (numbers must match if given).
- "partial": the text supports part of it, or supports it only loosely or more weakly than stated.
- "unsupported": the cited text does not say this or contradicts it.
- "no_source": the claim cites nothing valid.
Judge only from the text given, not from your own knowledge.
Reply in JSON: {"verdicts":[{"claim":1,"verdict":"supported|partial|unsupported|no_source","note":"short reason"}]}`,
    user: `Claims:\n${list}\n\nCited papers:\n${src || "(none)"}`,
    temperature: 0,
    maxTokens: 2000,
  });
  const verdicts = claims.map((c, i) => {
    const hasValid = (c.citations || []).map(Number).some((n) => valid.has(n));
    const got = (v.verdicts || []).find((x) => Number(x.claim) === i + 1);
    return { claim: c.text, citations: c.citations || [], verdict: hasValid ? got?.verdict || "unsupported" : "no_source", note: got?.note || "" };
  });
  return { claims, verdicts, pooled };
}

// ---------- 3. rubric ----------
async function rubric(rec) {
  const q = Q[rec.id];
  const answerable = q.group === "answerable" || q.group === "multi_part";
  const out = await chatJSON({
    system: `You grade answers from an AI literature research assistant against an answer key written by an expert. Be strict and consistent. Score each item 0, 1 or 2; when unsure between two scores, give the lower one.
${answerable ? `accuracy: 2 = bottom line matches the key, with the right direction and rough size of effect; 1 = right direction but wrong/missing size, or misses the key trial or a main point; 0 = wrong or no conclusion.
evidence_weighting: 2 = names study types/sizes, trusts RCTs and meta-analyses over lab or observational work, flags conflicts or limits; 1 = mentions study types but treats them as equal or counts studies as votes; 0 = no weighting, a weak study drives the conclusion.` : `handles_missing: 2 = clearly says the evidence does not exist, or rejects the false premise, in the first lines, and invents nothing; 1 = adds caveats but still partly answers as if the premise were true or as if data existed; 0 = invents results, numbers or a study, or goes along with the false premise.`}
focus: 2 = answers every part asked, in order, with nothing major unasked; 1 = one part missing/thin or a long tangent; 0 = misses the main question or most parts.
Reply in JSON: {${answerable ? '"accuracy":0,"accuracy_reason":"...","evidence_weighting":0,"evidence_weighting_reason":"...",' : '"handles_missing":0,"handles_missing_reason":"...",'}"focus":0,"focus_reason":"..."}`,
    user: `Question (${q.group.replace("_", " ")}): ${q.question}\n\nAnswer key: ${q.key}\n\nAnswer to grade:\n${anon(rec)}`,
    temperature: 0,
    maxTokens: 700,
  });
  return out;
}

// ---------- run grading ----------
const files = fs.readdirSync(rawDir).filter((f) => f.endsWith(".json"));
const todo = files.filter((f) => !fs.existsSync(path.join(gradedDir, f)));
console.log(`grading ${todo.length} of ${files.length}`);
let next = 0, done = 0;
async function worker() {
  while (next < todo.length) {
    const f = todo[next++];
    const rec = JSON.parse(fs.readFileSync(path.join(rawDir, f)));
    try {
      const checked = [];
      for (const r of rec.references) checked.push({ n: r.n, title: r.title, ...(await checkRef(r)) });
      const [cs, rb] = await Promise.all([claimSupport(rec, checked), rubric(rec)]);
      const g = { system: rec.system, id: rec.id, run: rec.run, group: Q[rec.id].group, seconds: rec.seconds, citations: checked.map(({ record, ...c }) => ({ ...c, pmid: record?.pmid || null })), claims: cs.verdicts, pooled_citations: Boolean(cs.pooled), rubric: rb };
      fs.writeFileSync(path.join(gradedDir, f), JSON.stringify(g, null, 1));
      console.log(`[${++done}/${todo.length}] ${f}`);
    } catch (err) {
      console.log(`[${++done}/${todo.length}] ${f} FAILED: ${err.message}`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

// ---------- 4. consistency ----------
const graded = fs.readdirSync(gradedDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(gradedDir, f))));
const consPath = path.join(base, "consistency.json");
const cons = fs.existsSync(consPath) ? JSON.parse(fs.readFileSync(consPath)) : {};
const groups = {};
for (const g of graded) (groups[`${g.system}__${g.id}`] ||= []).push(g);
for (const [k, gs] of Object.entries(groups)) {
  if (gs.length < 2 || (cons[k] && cons[k].runs === gs.length)) continue;
  const texts = gs.map((g) => JSON.parse(fs.readFileSync(path.join(rawDir, `${g.system}__${g.id}__r${g.run}.json`))).text);
  const out = await chatJSON({
    system: `Several answers to the same question are given. Decide whether they all reach the same bottom line (same conclusion and direction; wording, detail and citations may differ; saying "no evidence" vs giving a firm answer counts as different). Reply in JSON: {"same_bottom_line":true,"reason":"..."}`,
    user: `Question: ${Q[gs[0].id].question}\n\n` + texts.map((t, i) => `Answer ${i + 1}:\n${t.slice(0, 2500)}`).join("\n\n"),
    temperature: 0,
    maxTokens: 300,
  }).catch(() => ({ same_bottom_line: null }));
  const sets = gs.map((g) => new Set(g.citations.filter((c) => c.pmid).map((c) => c.pmid)));
  let jac = [], pairs = 0;
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
    const u = new Set([...sets[i], ...sets[j]]);
    if (!u.size) continue;
    jac.push([...sets[i]].filter((x) => sets[j].has(x)).length / u.size); pairs++;
  }
  cons[k] = { runs: gs.length, same_bottom_line: out.same_bottom_line, reason: out.reason || "", citation_overlap: pairs ? jac.reduce((a, b) => a + b, 0) / pairs : null };
  fs.writeFileSync(consPath, JSON.stringify(cons, null, 1));
}
console.log("graded; consistency computed for", Object.keys(cons).length, "system-question pairs");
