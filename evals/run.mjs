// Runs each system on each question N times and saves raw answers.
// Usage: node --import ./json-loader.mjs run.mjs --set practice --runs 3 [--systems litpeer,llm_only,rag_simple] [--only H1,F3]
// Resumable: existing answer files are skipped. No server is started.
import fs from "node:fs";
import path from "node:path";
import { SYSTEMS } from "./systems.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const set = arg("set", "practice");
const out = arg("out", set); // results subfolder
const runs = Number(arg("runs", 3));
const systems = arg("systems", Object.keys(SYSTEMS).join(",")).split(",");
const only = arg("only", "") ? arg("only").split(",") : null;
const CONC = Number(arg("conc", 4));

const questions = JSON.parse(fs.readFileSync(new URL("./questions.json", import.meta.url)))[set].filter((q) => !only || only.includes(q.id));
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "results", out, "raw");
fs.mkdirSync(dir, { recursive: true });

const jobs = [];
for (let r = 1; r <= runs; r++) for (const q of questions) for (const s of systems) jobs.push({ q, s, r });
const todo = jobs.filter((j) => !fs.existsSync(path.join(dir, `${j.s}__${j.q.id}__r${j.r}.json`)));
console.log(`${set}: ${todo.length} of ${jobs.length} runs to do`);

let next = 0, done = 0;
async function worker() {
  while (next < todo.length) {
    const { q, s, r } = todo[next++];
    const t0 = Date.now();
    try {
      const out = await SYSTEMS[s](q.question);
      const rec = { system: s, id: q.id, run: r, question: q.question, seconds: Math.round((Date.now() - t0) / 1000), ...out };
      fs.writeFileSync(path.join(dir, `${s}__${q.id}__r${r}.json`), JSON.stringify(rec, null, 1));
      console.log(`[${++done}/${todo.length}] ${s} ${q.id} r${r} ok ${rec.seconds}s, ${out.references.length} refs`);
    } catch (err) {
      console.log(`[${++done}/${todo.length}] ${s} ${q.id} r${r} FAILED: ${err.message}`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log("done");
