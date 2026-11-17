// The three systems under test. All use the same base model (DeepSeek), so any
// difference comes from the pipeline, not the model.
//   litpeer    - the full LitPeer pipeline (lib/pipeline.js)
//   llm_only   - DeepSeek answering from memory, asked to cite papers (like a general chatbot)
//   rag_simple - one PubMed search + one summarizing call (like a basic "search and summarize" tool):
//                no sub-questions, screening, evidence grading or Verifier
// Every system returns { text, references:[{n,title,authors,year,journal,pmid,doi}] }.

import { runPipeline } from "../lib/pipeline.js";
import { chatJSON } from "../lib/llm.js";
import { pubmedSearch, pubmedFetch } from "../lib/acquire.js";

function renderLitPeer(d) {
  if (!d.answer) return { text: (d.paragraphs || []).join("\n\n"), references: [] };
  const cite = (c) => (c.citations?.length ? ` [${c.citations.join(", ")}]` : "");
  const parts = [];
  if (d.answer.opening?.length) parts.push(d.answer.opening.map((c) => c.text + cite(c)).join(" "));
  for (const s of d.answer.sections) {
    let body = "";
    for (const c of s.claims) body += (c.new_paragraph && body ? "\n\n" : body ? " " : "") + c.text + cite(c);
    parts.push(`## ${s.heading}\n${body}`);
  }
  if (d.answer.not_covered?.length) parts.push(`## Not answered by these papers\n${d.answer.not_covered.map((t) => `- ${t}`).join("\n")}`);
  if (d.answer.limitations) parts.push(`## How strong is the evidence\n${typeof d.answer.limitations === "string" ? d.answer.limitations : JSON.stringify(d.answer.limitations)}`);
  const references = d.papers.filter((p) => p.cited).map((p) => ({ n: p.ref, title: p.title, authors: p.authors, year: p.year, journal: p.journal, pmid: p.pmid || null, doi: p.doi || null }));
  return { text: parts.join("\n\n"), references };
}

export async function litpeer(question) {
  let final = null;
  let error = null;
  await runPipeline(question, (e) => {
    if (e.type === "final") final = e.data;
  }).catch((err) => (error = err));
  if (error) throw error;
  if (!final) throw new Error("LitPeer produced no final answer");
  return { ...renderLitPeer(final), meta: { seconds: final.seconds, verifier_rounds: final.rounds, removed: final.answer?.removed?.length || 0 } };
}

export async function llm_only(question) {
  const out = await chatJSON({
    system: `You are an AI research assistant for biology, healthcare and drug discovery. Answer the user's question using the published scientific literature. Cite your sources inline as [1], [2], ... and give a reference list. For each reference give the title, authors, year, journal, and the PMID or DOI if you know it.
Reply in JSON: {"answer":"the answer in Markdown, with inline [n] citations","references":[{"n":1,"title":"...","authors":"...","year":"...","journal":"...","pmid":"... or null","doi":"... or null"}]}`,
    user: question,
    temperature: 0.3,
    maxTokens: 2500,
  });
  return { text: String(out.answer || ""), references: (out.references || []).map((r, i) => ({ n: Number(r.n) || i + 1, title: r.title || "", authors: r.authors || "", year: String(r.year || ""), journal: r.journal || "", pmid: r.pmid && /^\d+$/.test(String(r.pmid)) ? String(r.pmid) : null, doi: r.doi && r.doi !== "null" ? String(r.doi) : null })), meta: {} };
}

export async function rag_simple(question) {
  const q = await chatJSON({
    system: `Write one PubMed search query (plain keywords joined with AND/OR, 3-6 terms) for the user's question. Reply in JSON: {"query":"..."}`,
    user: question,
    temperature: 0,
    maxTokens: 200,
  });
  const { ids } = await pubmedSearch(String(q.query || question), 8);
  const papers = await pubmedFetch(ids.slice(0, 8));
  const block = papers.map((p, i) => `[${i + 1}] ${p.title} (${p.authors}, ${p.journal}, ${p.year})\n${p.abstract}`).join("\n\n");
  const out = await chatJSON({
    system: `You are an AI research assistant. Answer the user's question using the papers provided. Cite them inline as [1], [2] using their numbers. Reply in JSON: {"answer":"the answer in Markdown with inline [n] citations"}`,
    user: `Question: ${question}\n\nPapers:\n${block || "(no papers found)"}`,
    temperature: 0.3,
    maxTokens: 2000,
  });
  return { text: String(out.answer || ""), references: papers.map((p, i) => ({ n: i + 1, title: p.title, authors: p.authors, year: p.year, journal: p.journal, pmid: p.pmid, doi: p.doi })), meta: { query: q.query, found: papers.length } };
}

export const SYSTEMS = { litpeer, llm_only, rag_simple };
