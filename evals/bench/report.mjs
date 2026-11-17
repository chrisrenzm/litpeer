// Summarizes a benchmark run: scores per system, measured tokens and cost per question,
// and projected cost for other sample sizes.
// Usage (from evals/): node bench/report.mjs --out litqa2-n30 [--sizes 25,50,100,199]
import fs from "node:fs";
import path from "node:path";
import { PRICES, cost } from "./prices.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const outName = arg("out");
const sizes = arg("sizes", "25,50,100,199").split(",").map(Number);
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "results", "bench", outName);
const recs = fs.readdirSync(dir).filter((f) => f.includes("__")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
const systems = [...new Set(recs.map((r) => r.system))];
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (x) => (isNaN(x) ? "–" : `${Math.round(x * 100)}%`);
const add = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + (b[k] || 0)]));

const lines = [`# Benchmark run: ${outName}`, "", `${recs.length} answers. Each answer is mapped to the benchmark's answer format by one DeepSeek call that sees only the answer text, then scored by exact match (no LLM judge).`, ""];
const types = [...new Set(recs.map((r) => r.type))];
lines.push("## Scores", "", "| System | Type | n | Correct | Answered (not 'insufficient'/'unclear') | Precision (correct / answered) | Extra |", "| --- | --- | --- | --- | --- | --- | --- |");
for (const s of systems) for (const t of types) {
  const rs = recs.filter((r) => r.system === s && r.type === t);
  if (!rs.length) continue;
  const sc = rs.map((r) => r.score);
  const correct = mean(sc.map((x) => x.correct ?? x.f1));
  const answered = mean(sc.map((x) => x.answered));
  const extra = t === "factoid" ? `lenient ${pct(mean(sc.map((x) => x.lenient)))}, MRR ${mean(sc.map((x) => x.mrr)).toFixed(2)}` : t === "list" ? `P ${pct(mean(sc.map((x) => x.precision)))}, R ${pct(mean(sc.map((x) => x.recall)))} (Correct = F1)` : "";
  const answeredRecs = sc.filter((x) => x.answered);
  const prec = t === "list" ? "–" : pct(answeredRecs.length ? mean(answeredRecs.map((x) => x.correct)) : NaN);
  lines.push(`| ${s} | ${t} | ${rs.length} | ${pct(correct)} | ${pct(answered)} | ${prec} | ${extra} |`);
}

lines.push("", "## Measured tokens and cost per question (system + answer extraction)", "", "| System | LLM calls | Input tokens | of which cache hits | Output tokens | Median seconds | $ off-peak | $ peak |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
const perQ = {};
for (const s of systems) {
  const rs = recs.filter((r) => r.system === s);
  const us = rs.map((r) => add(r.usage.system, r.usage.extract));
  const avg = Object.fromEntries(Object.keys(us[0]).map((k) => [k, mean(us.map((u) => u[k]))]));
  const secs = rs.map((r) => r.seconds).sort((a, b) => a - b)[Math.floor(rs.length / 2)];
  perQ[s] = { off: cost(avg, PRICES["flash-offpeak"]), peak: cost(avg, PRICES["flash-peak"]) };
  lines.push(`| ${s} | ${avg.calls.toFixed(1)} | ${Math.round(avg.prompt_tokens).toLocaleString()} | ${Math.round(avg.cache_hit_tokens).toLocaleString()} | ${Math.round(avg.completion_tokens).toLocaleString()} | ${secs} | $${perQ[s].off.toFixed(4)} | $${perQ[s].peak.toFixed(4)} |`);
}
const all = Object.values(perQ).reduce((a, b) => ({ off: a.off + b.off, peak: a.peak + b.peak }), { off: 0, peak: 0 });
lines.push("", "## Projected cost (all systems above, 1 run each)", "", `| Questions | ${systems.map((s) => `${s} (off-peak / peak)`).join(" | ")} | Total off-peak | Total peak |`, `| --- | ${systems.map(() => "---").join(" | ")} | --- | --- |`);
for (const n of sizes) lines.push(`| ${n} | ${systems.map((s) => `$${(perQ[s].off * n).toFixed(2)} / $${(perQ[s].peak * n).toFixed(2)}`).join(" | ")} | $${(all.off * n).toFixed(2)} | $${(all.peak * n).toFixed(2)} |`);
const md = lines.join("\n") + "\n";
fs.writeFileSync(path.join(dir, "summary.md"), md);
console.log(md);
