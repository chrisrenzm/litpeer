// Downloads MedREQAL (2,786 questions from Cochrane systematic reviews; github.com/jvladika/MedREQAL)
// into evals/bench/data/medreqal.csv.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./datasets.mjs";

const res = await fetch("https://raw.githubusercontent.com/jvladika/MedREQAL/main/MedREQAL.csv");
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, "medreqal.csv"), await res.text());
console.log(`Saved MedREQAL to ${DATA_DIR}/medreqal.csv`);
