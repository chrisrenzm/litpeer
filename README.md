# LitPeer MVP

AI literature assistant for biology, healthcare and drug discovery (DATASCI 101 final project).

**Pipeline:** Orchestrator (splits the question into 1–4 sub-questions, writes 3 PubMed queries for each) → one lane per sub-question:
- Paper Acquirer: searches PubMed with the 3 queries (30–50 candidates), a Screener agent ranks titles/abstracts and picks the best 5–8 with a reason each, runs one refined search if coverage is thin, then pulls free full text (Methods + Results) from PubMed Central
- Extractor: one call per paper, from full text when available, otherwise the abstract
- Evaluator: grades each paper with a field-specific rubric

→ Synthesizer → Verifier (checks claims against abstracts, full-text results and quotes; sends unsupported claims back, up to 2 revisions). Every claim is cited; sub-questions
the papers don't answer are marked "Not covered".

**Chat:** follow-ups use the last 3 turns. The Orchestrator rewrites a follow-up into a standalone question and runs the full pipeline, or, if it only asks to explain/simplify the earlier answer, answers from that answer and its cited papers without a new search.

- Base model: DeepSeek (`deepseek-chat`) via its OpenAI-compatible API
- Papers: PubMed E-utilities + PubMed Central full text; Europe PMC and a bundled set of 26 GLP-1 papers (`lib/corpus.json`) as fallbacks. Optional `NCBI_API_KEY` in `.env.local` raises NCBI's rate limit from 3 to 10 requests/second.
- Stack: Next.js 14 (one page + one streaming API route), no database, Vercel-ready

## Run locally

```bash
npm install
cp .env.example .env.local   # then put your DeepSeek key in .env.local
npm run dev                  # open http://localhost:3000
```

`.env.local` is git-ignored. Never commit it.

## Files

- `lib/pipeline.js` – all agents and the verify loop
- `lib/rubrics.js` – extraction fields and grading rubrics per evidence type (lab, clinical, pharmacology). The Orchestrator splits a question by its own logic; each sub-question is only tagged with the kind of study that answers it
- `lib/acquire.js` – paper search (Europe PMC, PubMed, bundled corpus)
- `lib/llm.js` – DeepSeek client (JSON mode)
- `app/api/research/route.js` – streams pipeline events as NDJSON
- `app/page.js` – chat UI: sessions sidebar (kept in memory only, gone when the tab closes), Markdown/JSON download, Claude-style activity panel (planning thoughts + tool calls per sub-question), prose answer with verified inline citations and source cards

## Deploying to Vercel later

Import the folder as a Next.js project and add `DEEPSEEK_API_KEY` under Project → Settings → Environment Variables.
The API route sets `maxDuration = 300`; a full run takes about 1–3 minutes.

## Password gate (deployed site)

The whole site sits behind one shared password. `middleware.js` checks an HttpOnly cookie
(an HMAC of the password, set by `/api/login`) on every page and API call and sends anyone
without it to `/login`. Set these in Vercel → Project → Settings → Environment Variables:

- `DEEPSEEK_API_KEY` – server-side only, never sent to the browser
- `SITE_PASSWORD` – the shared password. Changing it signs everyone out.

Without `SITE_PASSWORD` the deployed site refuses all requests; in `npm run dev` it is open.
