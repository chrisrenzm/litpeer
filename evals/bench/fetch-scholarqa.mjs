// Downloads ScholarQABench-Bio (1,451 expert-written biomedical literature questions,
// github.com/AkariAsai/ScholarQABench) into evals/bench/data/scholarqa_bio.jsonl.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./datasets.mjs";

const res = await fetch("https://raw.githubusercontent.com/AkariAsai/ScholarQABench/main/data/scholarqa_bio/scholarqabench_bio.jsonl");
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
const text = await res.text();
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, "scholarqa_bio.jsonl"), text);
console.log(`Saved ${text.split("\n").filter(Boolean).length} ScholarQABench-Bio questions`);
