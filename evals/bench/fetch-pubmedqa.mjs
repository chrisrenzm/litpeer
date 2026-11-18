// Downloads PubMedQA's 1,000 expert-labelled questions and the official 500-question test split
// (github.com/pubmedqa/pubmedqa, MIT licence) into evals/bench/data/pubmedqa.json.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./datasets.mjs";

const BASE = "https://raw.githubusercontent.com/pubmedqa/pubmedqa/master/data";
const get = async (f) => { const r = await fetch(`${BASE}/${f}`); if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.json(); };
const [questions, test] = await Promise.all([get("ori_pqal.json"), get("test_ground_truth.json")]);
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, "pubmedqa.json"), JSON.stringify({ questions, test }));
console.log(`Saved ${Object.keys(questions).length} PubMedQA questions (${Object.keys(test).length} in the test split)`);
