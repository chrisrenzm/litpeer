// LitPeer multi-agent pipeline.
// Orchestrator -> N lanes (Acquirer: search -> screen -> [refine] -> full text; Extractor; Evaluator)
// -> Synthesizer <-> Verifier.
// `emit` streams progress events to the UI.

import { chatJSON } from "./llm.js";
import { gatherCandidates, pmcFullText } from "./acquire.js";
import { FIELDS, normalizeField } from "./rubrics.js";
import { throwIfStopped } from "./abort.js";

const CANDIDATE_CAP = 45; // candidates pulled per lane
const PICK_MIN = 5;
const PICK_MAX = 8;
const MAX_VERIFY_ROUNDS = 3; // 1 draft + up to 2 revisions

// ---------- Orchestrator ----------
function historyBlock(history) {
  if (!history?.length) return "";
  return history
    .map((h, i) => `Turn ${i + 1}\nUser: ${h.question}\nLitPeer answered: ${String(h.answer || "").slice(0, 1800)}${h.papers?.length ? `\nPapers cited in that answer: ${h.papers.map((p) => `[${p.ref}] ${p.title} (${p.year})`).join("; ").slice(0, 1500)}` : ""}`)
    .join("\n\n");
}

async function orchestrate(question, history) {
  const hist = historyBlock(history);
  const out = await chatJSON({
    system: `You are the Orchestrator of LitPeer, a literature research assistant covering biology, healthcare and drug discovery.
${hist ? `This message is part of an ongoing conversation (shown below). First decide what the user wants:
- "research": the message asks something that needs new papers. Rewrite it as a standalone research question that makes sense without the conversation (resolve words like "they", "it", "that drug") and put it in "standalone_question".
- "followup": the message only asks to explain, simplify, compare or reformat what LitPeer already answered, and the earlier answer contains what is needed. Then set "sub_questions" to [] and explain in "reason".
For "research": ` : ""}First work out exactly what the user is asking: list the distinct things they want to know, in their own terms. Then turn those into 1 to 4 focused sub-questions that follow the question's own logic (for example "does it work?" and "how large is the effect?", or "what causes X?" and "can it be reversed?"), NOT a split by scientific field.
- Use the FEWEST sub-questions that cover what was asked: 1 for a narrow single-point question, 2-3 when the user asks several distinct things, 4 only for broad, multi-part questions.
- Never add aspects the user did not ask about. If they ask whether a drug works, do not add mechanism, safety, cost or other drugs; if they ask about a mechanism, do not add clinical efficacy.
- Two sub-questions must not overlap.
For each sub-question also give:
- "heading": a 2-5 word label for it in plain words (e.g. "Effect on heart attacks").
- "evidence": the kind of study that answers it best, used only to pick search filters and the grading rubric: "clinical" (patients, trials, cohorts), "lab" (mechanisms, cells, animal models), or "pharmacology" (targets, compounds, assays, potency).
For each sub-question write 3 different PubMed search queries that approach it from different angles (synonyms, specific drug names, specific mechanisms or outcomes). Use plain keywords with AND/OR, 3-8 terms each. You may use PubMed tags such as [pt] or [tiab] sparingly, e.g. randomized controlled trial[pt] for clinical questions.
Also write "thinking": 2-3 sentences in first person on how you read the question and why you split it this way (e.g. "The user is asking two things: ... I will not look into ... because they did not ask about it.").
Reply in JSON: {${hist ? '"mode":"research|followup","standalone_question":"...",' : ""}"complexity":"low|medium|high","thinking":"...","reason":"one sentence on why this many sub-questions","sub_questions":[{"question":"...","heading":"...","evidence":"clinical|lab|pharmacology","search_queries":["...","...","..."]}]}`,
    user: `${hist ? `Conversation so far:\n${hist}\n\nNew message: ` : "Research question: "}${question}`,
    temperature: 0.1,
    maxTokens: 1400,
  });
  if (hist && out.mode === "followup") {
    return { mode: "followup", complexity: "low", thinking: out.thinking || "", reason: out.reason || "", standalone_question: question, sub_questions: [] };
  }
  const standalone = String(out.standalone_question || question);
  const subs = (out.sub_questions || []).slice(0, 4).map((s) => {
    const qs = [].concat(s.search_queries || s.search_query || []).map(String).filter(Boolean).slice(0, 3);
    return { question: String(s.question || standalone), heading: String(s.heading || "").slice(0, 60), field: normalizeField(s.evidence || s.field), search_queries: qs.length ? qs : [String(s.question || question)] };
  });
  if (!subs.length) subs.push({ question: standalone, heading: "", field: "healthcare", search_queries: [standalone] });
  return { mode: "research", complexity: out.complexity || "medium", thinking: out.thinking || "", reason: out.reason || "", standalone_question: standalone, sub_questions: subs };
}

// ---------- Paper registry (global citation numbers across lanes) ----------
function makeRegistry() {
  const papers = [];
  const byKey = new Map();
  return {
    papers,
    add(p) {
      const key = p.pmid || p.doi || p.title.toLowerCase();
      if (byKey.has(key)) return byKey.get(key);
      const ref = papers.length + 1;
      byKey.set(key, ref);
      papers.push({ ref, ...p, extraction: null, grade: null, fulltext: null, screen_reason: null });
      return ref;
    },
    get(ref) {
      return papers[ref - 1];
    },
  };
}

// Run async fn over items with limited concurrency.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        throwIfStopped();
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

// ---------- Screener ----------
async function screen(sub, candidates, alreadyPicked = []) {
  const list = candidates
    .map((p, i) => `#${i} | ${p.year} | ${p.pubTypes.join(", ") || "article"} | ${p.title}\n   ${p.abstract.slice(0, 450)}`)
    .join("\n");
  const out = await chatJSON({
    system: `You are the Screener agent for ${FIELDS[sub.field].label} evidence. You see candidate papers (title + start of abstract) from PubMed searches.
Pick the ${PICK_MIN}-${PICK_MAX} papers that best answer the sub-question. Prefer:
- primary research that directly addresses the sub-question (trials, cohorts, experiments) over reviews, editorials and case reports;
- stronger designs for the field (${sub.field === "healthcare" ? "RCTs and meta-analyses of RCTs, larger samples" : sub.field === "biology" ? "in vivo mechanistic studies with clear methods" : "studies with quantitative potency/efficacy data"});
- a spread that covers different aspects of the sub-question, and recent work when quality is similar.
Then judge coverage: "good" if the picks together can answer the sub-question, "thin" if important aspects have no good paper.
If thin, write ONE refined PubMed query that would find what is missing.
Reply in JSON: {"picks":[{"index":<candidate #>,"reason":"max 18 words: why this paper"}],"coverage":"good|thin","missing":"what is missing, or empty","refined_query":"... or empty"}`,
    user: `Sub-question: ${sub.question}\n${alreadyPicked.length ? `\nAlready selected in an earlier pass (you may keep or replace them; they are listed as candidates too).\n` : ""}\nCandidates:\n${list}`,
    temperature: 0.1,
    maxTokens: 1500,
  });
  const picks = [];
  for (const pk of out.picks || []) {
    const c = candidates[Number(pk.index)];
    if (c && !picks.some((x) => x.paper === c)) picks.push({ paper: c, reason: String(pk.reason || "") });
  }
  return { picks: picks.slice(0, PICK_MAX), coverage: out.coverage === "thin" ? "thin" : "good", missing: out.missing || "", refined_query: out.refined_query || "" };
}

// ---------- Extractor (one call per paper, reads full text when available) ----------
async function extractOne(sub, p) {
  const schema = FIELDS[sub.field].extract;
  const text = p.fulltext
    ? `ABSTRACT: ${p.abstract}\n\nMETHODS (full text excerpt): ${p.fulltext.methods || "n/a"}\n\nRESULTS (full text excerpt): ${p.fulltext.results || "n/a"}`
    : `ABSTRACT: ${p.abstract}`;
  return chatJSON({
    system: `You are the Extractor agent for ${FIELDS[sub.field].label} papers. Extract ONLY what the text states. Never infer numbers. Use "not reported" when a field is missing.
Fields to extract: ${JSON.stringify(schema)}
Also give:
- "key_finding": 1-2 sentences answering the sub-question from this paper, with the main numbers (or "not relevant");
- "evidence_quote": a short verbatim quote (max 40 words) from the text that supports the key finding;
- "relevant": true/false.
Reply in JSON: {"relevant":true,"fields":{...},"key_finding":"...","evidence_quote":"..."}`,
    user: `Sub-question: ${sub.question}\n\nPaper: ${p.title} (${p.year}; ${p.pubTypes.join(", ")})\n${text}`,
    maxTokens: 900,
  });
}

// ---------- Evaluator ----------
async function evaluate(sub, lanePapers, data) {
  const out = await chatJSON({
    system: `You are the Evaluator agent for ${FIELDS[sub.field].label} evidence. Grade each paper's evidence for the sub-question using this rubric:
${FIELDS[sub.field].rubric}
Also rate relevance to the sub-question: 2 = directly answers it, 1 = partially, 0 = not relevant.
Reply in JSON: {"grades":[{"ref":<number>,"grade":"A|B|C|D","relevance":0|1|2,"rationale":"max 20 words"}]}`,
    user: `Sub-question: ${sub.question}\n\nPapers with extracted data:\n` +
      lanePapers
        .map((p) => `[${p.ref}] ${p.title} (${p.year}; ${p.pubTypes.join(", ") || "article"}; read: ${p.fulltext ? "full text" : "abstract only"})\nExtracted: ${JSON.stringify(data[p.ref]?.extraction?.fields || {})}\nKey finding: ${data[p.ref]?.extraction?.key_finding || ""}`)
        .join("\n\n"),
    maxTokens: 2500,
  });
  if (!Array.isArray(out.grades)) throw new Error("Evaluator returned no grades array");
  return out.grades;
}

// ---------- One lane ----------
async function runLane(i, sub, registry, emit) {
  const lane = { index: i, ...sub, refs: [], kept: [], data: {}, source: null };
  const ev = (step, status, data) => {
    throwIfStopped();
    emit({ type: "lane", lane: i, step, status, data });
  };

  // 1. Search: several query variations -> 30-50 candidates
  ev("search", "running", { queries: sub.search_queries });
  let found = await gatherCandidates(sub.search_queries, CANDIDATE_CAP);
  lane.source = found.source;
  let candidates = found.papers;
  ev("search", "done", { count: candidates.length, source: found.source, perQuery: found.perQuery, notes: found.notes });
  if (!candidates.length) {
    for (const s of ["screen", "fulltext", "extract", "evaluate"]) ev(s, "skipped");
    return lane;
  }

  // 2. Screen: pick the best 5-8 with reasons
  ev("screen", "running", { count: candidates.length });
  let sc = await screen(sub, candidates);
  const brief = (picks) => picks.map((x) => ({ title: x.paper.title, year: x.paper.year, pmid: x.paper.pmid, reason: x.reason }));
  ev("screen", "done", { screened: candidates.length, picks: brief(sc.picks), coverage: sc.coverage, missing: sc.missing });

  // 3. Refine once if coverage is thin
  if ((sc.coverage === "thin" || sc.picks.length < PICK_MIN) && sc.refined_query) {
    ev("refine", "running", { query: sc.refined_query, missing: sc.missing });
    const exclude = new Set(candidates.map((p) => p.pmid).filter(Boolean));
    const more = await gatherCandidates([sc.refined_query], 25, exclude);
    if (more.papers.length) {
      const pool = [...sc.picks.map((x) => x.paper), ...more.papers];
      const sc2 = await screen(sub, pool, sc.picks);
      if (sc2.picks.length) sc = sc2;
      candidates = [...candidates, ...more.papers];
    }
    ev("refine", "done", { query: sc.refined_query, added: more.papers.length, picks: brief(sc.picks), coverage: sc.coverage });
  }
  lane.screened = candidates.length;
  lane.refs = sc.picks.map((x) => {
    const ref = registry.add(x.paper);
    const p = registry.get(ref);
    if (!p.screen_reason) p.screen_reason = x.reason;
    return ref;
  });
  const papers = () => lane.refs.map((r) => registry.get(r));

  // 4. Full text from PubMed Central (open access) where available
  ev("fulltext", "running", { total: lane.refs.length });
  let got = 0;
  for (const p of papers()) {
    if (p.fulltext === null && p.pmcid) {
      try {
        p.fulltext = (await pmcFullText(p.pmcid)) || false;
      } catch {
        p.fulltext = false;
      }
    }
    if (p.fulltext) got++;
  }
  ev("fulltext", "done", { full: got, total: lane.refs.length });

  // 5. Extract (per paper, in parallel)
  let done = 0;
  ev("extract", "running", { done: 0, total: lane.refs.length });
  await mapLimit(papers(), 4, async (p) => {
    let ex;
    try {
      ex = await extractOne(sub, p);
    } catch (err) {
      throwIfStopped();
      console.error(`[LitPeer] Extractor failed for paper ${p.ref}: ${err.message}`);
      ex = { relevant: true, fields: {}, key_finding: "Extraction failed; see abstract.", evidence_quote: "" };
    }
    lane.data[p.ref] = { extraction: { ...ex, field: sub.field } };
    if (!p.extraction) p.extraction = { ...ex, field: sub.field };
    ev("extract", "progress", { done: ++done, total: lane.refs.length });
  });
  const relevantCount = papers().filter((p) => lane.data[p.ref]?.extraction?.relevant !== false).length;
  ev("extract", "done", { fields: Object.keys(FIELDS[sub.field].extract), relevant: relevantCount, total: lane.refs.length, full: got });

  // 6. Evaluate
  ev("evaluate", "running");
  let gr;
  let evFailed = false;
  try {
    gr = await evaluate(sub, papers(), lane.data);
  } catch (err) {
    throwIfStopped();
    console.error(`[LitPeer] Evaluator batch failed in lane ${i + 1}: ${err.message}. Grading papers one by one.`);
    // Fall back to grading each paper separately; only papers that still fail are marked ungraded.
    gr = (
      await mapLimit(papers(), 4, async (p) => {
        try {
          return (await evaluate(sub, [p], lane.data))[0] || null;
        } catch (e) {
          throwIfStopped();
          console.error(`[LitPeer] Evaluator failed for paper ${p.ref}: ${e.message}`);
          evFailed = true;
          return { ref: p.ref, grade: "C", relevance: lane.data[p.ref]?.extraction?.relevant === false ? 0 : 1, rationale: "Ungraded (Evaluator error); treat with caution" };
        }
      })
    ).filter(Boolean);
  }
  for (const g of gr) {
    const ref = Number(g.ref);
    if (!lane.refs.includes(ref)) continue;
    const grade = { grade: String(g.grade || "D").toUpperCase().slice(0, 1), relevance: Number(g.relevance ?? 0), rationale: g.rationale || "", field: sub.field };
    lane.data[ref].grade = grade;
    const p = registry.get(ref);
    if (!p.grade) p.grade = grade;
  }
  lane.kept = lane.refs.filter((r) => (lane.data[r]?.grade?.relevance ?? 0) > 0);
  const tally = {};
  for (const r of lane.kept) tally[lane.data[r].grade.grade] = (tally[lane.data[r].grade.grade] || 0) + 1;
  ev("evaluate", "done", { kept: lane.kept.length, total: lane.refs.length, tally, fallback: evFailed });
  return lane;
}

// ---------- Synthesizer ----------
function evidenceBlock(lanes, registry) {
  return lanes
    .map((l, i) => {
      const rows = (l.kept || [])
        .map((r) => {
          const p = registry.get(r);
          const d = l.data[r] || {};
          return `  [${r}] grade ${d.grade?.grade || "?"} | ${p.fulltext ? "full text" : "abstract"} | ${p.title} (${p.year}) | ${JSON.stringify(d.extraction?.fields || {})} | finding: ${d.extraction?.key_finding || ""}`;
        })
        .join("\n");
      return `Sub-question ${i + 1} (${FIELDS[l.field].label}): ${l.question}\n${rows || "  (no relevant papers found)"}`;
    })
    .join("\n\n");
}

async function synthesize(question, lanes, registry, feedback, previous, history) {
  const system = `You are the Synthesizer of LitPeer. Write an evidence-based answer to the user's question using ONLY the evidence table provided.
FOCUS: answer exactly what the user asked and nothing else. The evidence table may contain findings that are true but were not asked about (other drugs, other outcomes, other populations, mechanisms when only effects were asked, side notes). Leave those out, even if they are interesting. In particular, do not compare with other drugs or treatments unless the user asked for a comparison. A reader should be able to glance at the answer and find the answer to their question immediately.
FORMAT: short sections under subtitles, each made of coherent paragraphs of flowing prose (NOT bullet points). Return JSON so each sentence can be checked:
- "opening": 1-3 sentences that directly answer the whole question (the bottom line, with the key number if there is one). No background, no preamble.
- "sections": 1-4 sections that group related points, ORDERED BY IMPORTANCE: the section that most directly answers the question comes first, supporting detail and nuance (subgroups, consistency, caveats) after. When the user asks two or more separate things, each gets its own section, in the order the user asked them. Group by point, not by paper or by field.
  - "heading": a short subtitle (2-6 words) in the user's terms that says what the section is about (e.g. "Size of the effect", "Who benefits most", "How it works in the brain"). No numbering, no "Section 1", no "Introduction".
  - "claims": the consecutive sentences of the section's paragraph, in reading order. Write them so they flow when joined: use transitions, vary sentence openings, do not repeat the opening, and do not start sentences with "Paper [n]" or "One study". 2-5 sentences per section; start a second paragraph only if really needed by setting "new_paragraph": true on its first sentence.
  - Only make a section for something the user asked about. Fewer, tighter sections are better than many.
- "not_covered": a list of plain sentences, one for each part of the user's question that got NO answer from the retrieved papers. Empty list if everything asked was answered (the usual case). Never list things the user did not ask, and do not mention individual papers, truncated abstracts or comparisons that were not asked for.
- "limitations": 1-2 sentences on how strong the evidence behind THIS answer is (study types, grades, animal vs human, follow-up length). No generic caveats.
- Put citations ONLY in the "citations" array. Never write [n] or reference numbers inside "text".
Rules:
- Every sentence in "opening" and "claims" must cite at least one paper by its number, and the cited paper must actually support it.
- Prefer higher-graded evidence (A > B > C > D) and say when evidence is weak (only C/D grades) or from animal/in vitro models.
- Include numbers when the evidence gives them, but only the numbers that matter for the question.
- Never fill gaps from general knowledge.
- Length: about 120-200 words for a narrow question and at most 350 words for a broad one. At most 4 sentences per section. If you have more findings than fit, keep the strongest and most directly relevant ones and drop the rest.
- Each heading must describe the sentences under it. Write the claims first in your head, then name the section.
${history?.length ? "- This is a follow-up in a conversation. Connect to what was said before where natural, but do not repeat earlier answers.\n" : ""}Reply in JSON: {"opening":[{"text":"...","citations":[n]}],"sections":[{"heading":"...","claims":[{"text":"...","citations":[n],"new_paragraph":false}]}],"not_covered":["..."],"limitations":"..."}`;
  let user = `${history?.length ? `Earlier conversation:\n${historyBlock(history)}\n\n` : ""}Research question: ${question}\n\nEvidence table (paper number, grade, title, extracted fields, finding):\n${evidenceBlock(lanes, registry)}`;
  if (feedback?.length) {
    user += `\n\nYour previous draft:\n${JSON.stringify(previous)}\n\nThe Verifier found these problems. Fix each one: rewrite the claim so the cited paper supports it, cite the correct paper, or remove the claim. Do not add new uncited claims, and keep the same focus and order. Make sure every heading still matches the sentences under it after your fixes, and drop a section entirely if none of its sentences survive.\n` +
      feedback.map((f) => `- ${f.id} "${f.text}": ${f.verdict} — ${f.note}`).join("\n");
  }
  return chatJSON({ system, user, temperature: 0.2, maxTokens: 3000 });
}

function flattenClaims(draft) {
  const claims = [];
  const opening = Array.isArray(draft.opening) ? draft.opening : draft.opening?.text ? [draft.opening] : [];
  opening.forEach((c, k) => c?.text && claims.push({ id: `C${claims.length}`, text: c.text, citations: c.citations || [], loc: ["opening", k] }));
  (draft.sections || []).forEach((s, si) =>
    (s.claims || []).forEach((c, ci) => claims.push({ id: `C${claims.length}`, text: c.text, citations: c.citations || [], loc: [si, ci] }))
  );
  return claims;
}

// ---------- Verifier ----------
// Source text the Verifier checks a paper against: abstract plus full-text results excerpt and extracted quotes.
function sourceText(r, registry, lanes) {
  const p = registry.get(r);
  const quotes = lanes.map((l) => l.data?.[r]?.extraction?.evidence_quote).filter(Boolean);
  let t = `ABSTRACT: ${p.abstract}`;
  if (p.fulltext?.results) t += `\nRESULTS (full text excerpt): ${p.fulltext.results.slice(0, 2000)}`;
  if (quotes.length) t += `\nQUOTES: ${quotes.map((q) => `"${q}"`).join(" ")}`;
  return t;
}

async function verify(claims, registry, lanes) {
  const cited = [...new Set(claims.flatMap((c) => c.citations.map(Number)))].filter((r) => registry.get(r));
  const out = await chatJSON({
    system: `You are the Verifier of LitPeer. For each claim, check whether the cited papers' text (abstract, full-text results excerpt, quotes) supports it. Be strict:
- "supported": the cited text clearly states this (numbers must match).
- "partial": broadly right but overstated, wrong number, or missing an important qualifier (e.g. it was in mice).
- "unsupported": the cited abstracts do not say this, or the claim has no citation.
Reply in JSON: {"verdicts":[{"id":"C0","verdict":"supported|partial|unsupported","note":"max 25 words"}]}`,
    user:
      `Claims:\n${claims.map((c) => `${c.id}: ${c.text} [cites ${c.citations.join(", ") || "none"}]`).join("\n")}\n\nCited abstracts:\n` +
      cited.map((r) => { const p = registry.get(r); return `[${r}] ${p.title} (${p.year})\n${sourceText(r, registry, lanes)}`; }).join("\n\n"),
    temperature: 0,
    maxTokens: 2000,
  });
  const byId = new Map((out.verdicts || []).map((v) => [v.id, v]));
  return claims.map((c) => {
    const v = byId.get(c.id) || { verdict: "unsupported", note: "Verifier gave no verdict" };
    const bad = !c.citations.length || c.citations.some((r) => !registry.get(Number(r)));
    return { ...c, verdict: bad ? "unsupported" : v.verdict, note: bad ? "Missing or invalid citation" : v.note };
  });
}

// Citations live in their own array; drop any "[3]" or "[2, 5]" the model also wrote into the sentence.
function cleanText(t) {
  return String(t || "").replace(/\s*\[\d+(?:\s*[,–-]\s*\d+)*\](?:\s*\[\d+(?:\s*[,–-]\s*\d+)*\])*/g, "").replace(/\s+([.,;:])/g, "$1").trim();
}

// ---------- Main ----------
// ---------- Follow-up responder (no new search) ----------
async function respondFollowup(message, history) {
  const last = history[history.length - 1] || {};
  const out = await chatJSON({
    system: `You are LitPeer, a literature research assistant. The user asked a follow-up about your earlier answers. Answer exactly what the follow-up asks, briefly, and nothing more. Use ONLY the earlier answers and the papers they cite, in clear, coherent paragraphs of prose (no bullet points). Keep the earlier citation numbers in square brackets, e.g. [2], when you restate a finding; they refer to the papers listed for the most recent turn. If the earlier answers do not contain what is needed, say so and suggest asking it as a new research question.
Reply in JSON: {"paragraphs":["...","..."],"citations":[n]}`,
    user: `Conversation so far:\n${historyBlock(history)}\n\nFollow-up: ${message}`,
    temperature: 0.3,
    maxTokens: 1500,
  });
  const paras = [].concat(out.paragraphs || []).map(String).filter(Boolean);
  const used = new Set(paras.join(" ").match(/\[(\d+)\]/g)?.map((m) => Number(m.slice(1, -1))) || []);
  return { paragraphs: paras, papers: (last.papers || []).filter((p) => used.has(Number(p.ref))) };
}

export async function runPipeline(question, emit, history = []) {
  const t0 = Date.now();

  emit({ type: "stage", stage: "orchestrator", status: "running" });
  const plan = await orchestrate(question, history);
  emit({ type: "stage", stage: "orchestrator", status: "done", data: plan });

  if (plan.mode === "followup") {
    emit({ type: "stage", stage: "responder", status: "running" });
    const r = await respondFollowup(question, history);
    emit({ type: "stage", stage: "responder", status: "done" });
    emit({ type: "final", data: { question, plan, followup: true, paragraphs: r.paragraphs, papers: r.papers.map((p) => ({ ...p, cited: true })), lanes: [], rounds: [], seconds: Math.round((Date.now() - t0) / 1000) } });
    return;
  }
  const rq = plan.standalone_question || question;

  const registry = makeRegistry();
  const lanes = await Promise.all(
    plan.sub_questions.map((sub, i) =>
      runLane(i, sub, registry, emit).catch((err) => {
        throwIfStopped();
        emit({ type: "lane", lane: i, step: "error", status: "error", data: { message: err.message } });
        return { index: i, ...sub, refs: [], kept: [], data: {} };
      })
    )
  );

  let draft = null;
  let checked = [];
  let feedback = null;
  const rounds = [];
  for (let round = 1; round <= MAX_VERIFY_ROUNDS; round++) {
    throwIfStopped();
    emit({ type: "stage", stage: "synthesizer", status: "running", data: { round } });
    draft = await synthesize(rq, lanes, registry, feedback, draft, history);
    emit({ type: "stage", stage: "synthesizer", status: "done", data: { round } });

    emit({ type: "stage", stage: "verifier", status: "running", data: { round } });
    checked = await verify(flattenClaims(draft), registry, lanes);
    const problems = checked.filter((c) => c.verdict !== "supported");
    rounds.push({ round, total: checked.length, supported: checked.length - problems.length, problems: problems.map((p) => ({ text: p.text, verdict: p.verdict, note: p.note })) });
    emit({ type: "stage", stage: "verifier", status: problems.length && round < MAX_VERIFY_ROUNDS ? "loop" : "done", data: { rounds } });
    if (!problems.length) break;
    feedback = problems;
  }

  // Build the final answer: keep supported/partial claims (partial gets flagged), drop unsupported ones.
  const verdictAt = new Map(checked.map((c) => [JSON.stringify(c.loc), c]));
  const removed = checked.filter((c) => c.verdict === "unsupported").map((c) => ({ text: c.text, note: c.note }));
  const openingSrc = Array.isArray(draft.opening) ? draft.opening : draft.opening?.text ? [draft.opening] : [];
  const answer = {
    opening: openingSrc
      .map((c, k) => ({ ...c, ...(verdictAt.get(JSON.stringify(["opening", k])) || {}) }))
      .filter((c) => c.text && c.verdict !== "unsupported")
      .map(({ text, citations, verdict, note }) => ({ text: cleanText(text), citations, verdict, note })),
    sections: (draft.sections || [])
      .map((s, si) => {
        const claims = (s.claims || [])
          .map((c, ci) => ({ ...c, ...(verdictAt.get(JSON.stringify([si, ci])) || {}) }))
          .filter((c) => c.verdict !== "unsupported")
          .map(({ text, citations, verdict, note, new_paragraph }) => ({ text: cleanText(text), citations, verdict, note, new_paragraph: Boolean(new_paragraph) }));
        return { heading: cleanText(s.heading || s.sub_question || ""), claims };
      })
      .filter((s) => s.claims.length),
    not_covered: [].concat(draft.not_covered || []).map((t) => cleanText(t)).filter(Boolean),
    limitations: draft.limitations || "",
    removed,
  };

  const citedRefs = new Set(
    [...answer.opening.flatMap((c) => c.citations), ...answer.sections.flatMap((s) => s.claims.flatMap((c) => c.citations))].map(Number)
  );
  emit({
    type: "final",
    data: {
      question,
      plan,
      answer,
      rounds,
      papers: registry.papers.map(({ fulltext, ...p }) => ({ ...p, fulltext: Boolean(fulltext), cited: citedRefs.has(p.ref) })),
      lanes: lanes.map((l) => ({ question: l.question, field: l.field, refs: l.refs, kept: l.kept || [], source: l.source, screened: l.screened || 0 })),
      seconds: Math.round((Date.now() - t0) / 1000),
    },
  });
}
