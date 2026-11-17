// Downloads the 199 public LitQA2 questions (FutureHouse LAB-Bench, CC BY-SA 4.0) into evals/bench/data/.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./datasets.mjs";

const URL_ = "https://raw.githubusercontent.com/Future-House/LAB-Bench/main/LitQA2/litqa-v2-public.jsonl";
const res = await fetch(URL_);
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
const text = await res.text();
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, "litqa2.jsonl"), text);
console.log(`Saved ${text.split("\n").filter(Boolean).length} LitQA2 questions to ${DATA_DIR}/litqa2.jsonl`);
