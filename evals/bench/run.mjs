// Runs systems on a public-benchmark sample, extracts each answer, scores it and logs token usage.
// Usage (from evals/):
//   node --import ./json-loader.mjs bench/run.mjs --bench litqa2 --n 30 [--seed 1]
//        [--systems litpeer,llm_only,rag_simple] [--runs 1] [--conc 3] [--out litqa2-n30]
// Resumable: finished answers are skipped. No server is started.
// Then: node bench/report.mjs --out litqa2-n30
import fs from "node:fs";
import path from "node:path";
import { SYSTEMS } from "../systems.mjs";
import { trackUsage } from "../../lib/llm.js";
import { loadBench, sample } from "./datasets.mjs";
import { promptFor, extract, score } from "./score.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const bench = arg("bench", "litqa2");
const n = Number(arg("n", 30));
const seed = arg("seed", "1");
const runs = Number(arg("runs", 1));
const systems = arg("systems", "litpeer,llm_only,rag_simple").split(",");
const CONC = Number(arg("conc", 3));
const outName = arg("out", `${bench}-n${n}`);
if (!process.env.DEEPSEEK_API_KEY) throw new Error("Set DEEPSEEK_API_KEY");

const items = sample(loadBench(bench), n, seed);
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "results", "bench", outName);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "sample.json"), JSON.stringify({ bench, n, seed, ids: items.map((i) => i.id) }, null, 1));

const jobs = [];
for (let r = 1; r <= runs; r++) for (const it of items) for (const s of systems) jobs.push({ it, s, r });
const file = (j) => path.join(dir, `${j.s}__${j.it.id}__r${j.r}.json`);
const todo = jobs.filter((j) => !fs.existsSync(file(j)));
console.log(`${bench}: ${items.length} questions x ${systems.length} systems x ${runs} runs; ${todo.length} of ${jobs.length} to do`);

let next = 0, done = 0;
async function worker() {
  while (next < todo.length) {
    const j = todo[next++];
    const t0 = Date.now();
    try {
      const sys = await trackUsage(() => SYSTEMS[j.s](promptFor(j.it)));
      const seconds = Math.round((Date.now() - t0) / 1000);
      const ex = await trackUsage(() => extract(j.it, sys.result.text));
      const rec = { system: j.s, id: j.it.id, bench, type: j.it.type, run: j.r, question: promptFor(j.it), seconds, answer: sys.result.text, references: sys.result.references.length, extracted: ex.result, gold: j.it.correct ?? j.it.gold, score: score(j.it, ex.result), usage: { system: sys.usage, extract: ex.usage } };
      fs.writeFileSync(file(j), JSON.stringify(rec, null, 1));
      console.log(`[${++done}/${todo.length}] ${j.s} ${j.it.id} ${seconds}s ${JSON.stringify(rec.score)} ${sys.usage.calls} calls`);
    } catch (err) {
      console.log(`[${++done}/${todo.length}] ${j.s} ${j.it.id} FAILED: ${err.message}`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log("done");
