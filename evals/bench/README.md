# Public benchmarks (LitQA2, BioASQ)

Runs LitPeer and the two baselines (`llm_only` = DeepSeek alone, `rag_simple` = one PubMed search + summary) on public biomedical QA benchmarks. Each system answers in prose as usual. One cheap DeepSeek call, which sees only the answer text, then maps it to the benchmark's answer format (a letter, yes/no, or entity names). Scoring is exact match, so no LLM judge is needed.

## Data

| Benchmark | What it is | How to get it |
| --- | --- | --- |
| LitQA2 (FutureHouse LAB-Bench) | 199 public multiple-choice questions; each answer is in one recent paper, often only in the full text. Every question has an "Insufficient information" option. | Free, no account: `node bench/fetch-litqa2.mjs` |
| BioASQ Task B | Biomedical questions written by experts over PubMed: yes/no, factoid, list (summary questions are skipped; they would need a judge). | Free, but needs an account. Register at https://participants-area.bioasq.org, download the Task B training set (e.g. `training13b.json`), save it as `evals/bench/data/bioasq.json`. |

`bench/data/` is git-ignored. LitQA2 asks that it never be put where it can end up in training data, and BioASQ's terms don't allow redistribution, so neither is committed.

## Run

From `evals/`, with `DEEPSEEK_API_KEY` set. No server is started.

```bash
node --import ./json-loader.mjs bench/run.mjs --bench litqa2 --n 199 --out litqa2-full
node --import ./json-loader.mjs bench/run.mjs --bench bioasq --n 150 --out bioasq-150   # 50 per type
node bench/report.mjs --out litqa2-full
```

Options: `--seed` (sample and option order are reproducible), `--systems litpeer,llm_only,rag_simple`, `--runs`, `--conc` (default 3). Runs are resumable: finished answers are skipped. `results/bench/<out>/summary.md` has the scores, the measured tokens per question, and projected cost for other sizes.

## Metrics

- LitQA2: accuracy (correct / all) and precision (correct / questions where the system did not pick "insufficient"), as in LAB-Bench.
- BioASQ yes/no: accuracy. Factoid: strict accuracy (top answer), lenient accuracy (any of top 5), MRR. List: precision, recall, F1. Matching is on normalized strings against BioASQ's synonym lists.

## Files

- `datasets.mjs`: loaders, seeded sampling (BioASQ stratified by type)
- `score.mjs`: question prompt, answer extraction, exact-match scoring
- `run.mjs`: runner; logs DeepSeek token usage per answer (`trackUsage` in `lib/llm.js`)
- `report.mjs`, `prices.mjs`: summary and cost (edit `prices.mjs` if DeepSeek changes prices)
