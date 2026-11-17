// Summarizes graded results into results/<set>/summary.md and scores.csv.
// Usage: node report.mjs --set practice
import fs from "node:fs";
import path from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const set = arg("set", "practice");
const out = arg("out", set); // results subfolder
const base = path.join(path.dirname(new URL(import.meta.url).pathname), "results", out);
const G = fs.readdirSync(path.join(base, "graded")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(base, "graded", f))));
const cons = fs.existsSync(path.join(base, "consistency.json")) ? JSON.parse(fs.readFileSync(path.join(base, "consistency.json"))) : {};
const NAMES = { litpeer: "LitPeer", litpeer_v1: "LitPeer (before fixes)", claude: "Claude (no search)", perplexity: "Perplexity (free)", consensus: "Consensus (free)", elicit: "Elicit (free)", rag_simple: "Search + summarize", llm_only: process.env.LITPEER_LLM === "claude" ? "Claude Sonnet, no search" : "Chatbot (no search)" };
const systems = Object.keys(NAMES).filter((s) => G.some((g) => g.system === s));
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
const mean = (xs) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "n/a");

const rows = [];
for (const s of systems) {
  const gs = G.filter((g) => g.system === s);
  const cites = gs.flatMap((g) => g.citations);
  const exist = cites.filter((c) => c.status === "exists").length;
  const web = cites.filter((c) => c.status === "web").length;
  const checkable = cites.filter((c) => c.status !== "web" && c.status !== "unchecked").length;
  const claims = gs.flatMap((g) => g.claims);
  const sup = claims.filter((c) => c.verdict === "supported").length;
  const part = claims.filter((c) => c.verdict === "partial").length;
  const bad = claims.filter((c) => c.verdict === "unsupported" || c.verdict === "no_source").length;
  const r = (k, groups) => gs.filter((g) => groups.includes(g.group) && typeof g.rubric?.[k] === "number").map((g) => g.rubric[k]);
  const cs = Object.entries(cons).filter(([k]) => k.startsWith(s + "__")).map(([, v]) => v);
  const ov = cs.map((c) => c.citation_overlap).filter((x) => x != null);
  rows.push({
    system: NAMES[s], answers: gs.length, citations: cites.length,
    cite_exists: pct(exist, checkable), web_sources: pct(web, cites.length), cites_per_answer: (cites.length / gs.length).toFixed(1),
    claims_supported: pct(sup + 0.5 * part, claims.length), claims_unsupported: pct(bad, claims.length),
    accuracy: mean(r("accuracy", ["answerable", "multi_part"])), evidence_weighting: mean(r("evidence_weighting", ["answerable", "multi_part"])),
    handles_missing: mean(r("handles_missing", ["unanswerable", "false_premise"])), focus: mean(r("focus", ["answerable", "multi_part", "unanswerable", "false_premise"])),
    consistent: pct(cs.filter((c) => c.same_bottom_line === true).length, cs.length), citation_overlap: ov.length ? pct(ov.reduce((a, b) => a + b, 0), ov.length) : "n/a",
    median_seconds: gs.map((g) => g.seconds).sort((a, b) => a - b)[Math.floor(gs.length / 2)],
  });
}
const cols = [["system", "System"], ["answers", "Answers"], ["cite_exists", "Paper citations that exist in PubMed"], ["web_sources", "Sources that are web pages, not papers"], ["cites_per_answer", "Citations per answer"], ["claims_supported", "Claims supported by cited paper"], ["claims_unsupported", "Claims with no valid support"], ["accuracy", "Accuracy (0-2)"], ["evidence_weighting", "Evidence weighting (0-2)"], ["handles_missing", "Handles missing evidence / false premise (0-2)"], ["focus", "Stays on question (0-2)"], ["consistent", "Same bottom line across runs"], ["citation_overlap", "Cited-paper overlap across runs"], ["median_seconds", "Median seconds"]];
let md = `# LitPeer eval: ${out}\n\nLitPeer, Search + summarize and Chatbot all use the same model (${process.env.LITPEER_LLM === "claude" ? "Claude Sonnet via Claude Code" : "DeepSeek"}), so differences between them come from the pipeline. Judge: same model, anonymized answers; claims checked against abstract + free full-text results.\n\n| ${cols.map((c) => c[1]).join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |\n`;
for (const r of rows) md += `| ${cols.map((c) => r[c[0]]).join(" | ")} |\n`;
if (G.some((g) => g.pooled_citations)) md += `\nPerplexity and Elicit answers were copied from the browser, which loses their inline citation markers. Their claims were checked against all of the answer's real cited papers at once, which is more lenient than the per-citation check the other systems got. They ran once per question (no consistency score). Elicit F7 is missing because the free usage limit ran out.\n`;

// per-question table
md += `\n## Per question (mean over runs)\n\n| Question | Group | ${systems.map((s) => NAMES[s]).join(" | ")} |\n| --- | --- | ${systems.map(() => "---").join(" | ")} |\n`;
const ids = [...new Set(G.map((g) => g.id))].sort();
for (const id of ids) {
  const cell = (s) => {
    const gs = G.filter((g) => g.system === s && g.id === id);
    if (!gs.length) return "";
    const main = gs[0].group === "answerable" || gs[0].group === "multi_part" ? "accuracy" : "handles_missing";
    const cl = gs.flatMap((g) => g.claims);
    const ok = cl.filter((c) => c.verdict === "supported").length + 0.5 * cl.filter((c) => c.verdict === "partial").length;
    return `${main === "accuracy" ? "acc" : "miss"} ${mean(gs.map((g) => g.rubric?.[main] ?? 0))}, support ${pct(ok, cl.length)}`;
  };
  md += `| ${id} | ${G.find((g) => g.id === id).group} | ${systems.map(cell).join(" | ")} |\n`;
}
fs.writeFileSync(path.join(base, "summary.md"), md);
fs.writeFileSync(path.join(base, "scores.csv"), [cols.map((c) => c[1]).join(","), ...rows.map((r) => cols.map((c) => `"${r[c[0]]}"`).join(","))].join("\n"));
console.log(md);
