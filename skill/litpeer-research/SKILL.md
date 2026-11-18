---
name: litpeer-research
description: Answer a biomedical research question (biology, clinical medicine or drug discovery) from PubMed papers, with graded evidence and every sentence cited and checked. Use for "what does the literature say about...", "is there evidence that...", or a lit search.
---

# LitPeer research workflow

LitPeer answers a research question the way a careful reviewer would: it splits the question into the parts the user actually asked, finds and screens real papers for each part, extracts and grades the evidence, writes a short cited answer, and then checks every sentence against the papers before showing it. You play every agent in this workflow yourself.

Use it for questions in biology, healthcare or drug discovery that need published evidence. It is not for medical advice to one patient, and it never fills gaps from general knowledge: if the papers do not say it, the answer does not say it.

## Ground rules

- Only real papers you actually retrieved in this session. Never cite from memory, never invent a PMID, author, number or trial.
- Answer exactly what was asked. Leave out true but unasked findings (other drugs, other outcomes, mechanism when only effect was asked, safety when only efficacy was asked).
- Prose, not bullet points, in the final answer. Short sections with plain-word headings.
- Every sentence of the answer cites at least one paper, and the cited paper must support it.
- Tell the user up front that this takes a few minutes, and give short progress lines as you go (e.g. "Searching PubMed for sub-question 2...").

## Tools for finding papers

Use the first one that works and say which you used:

1. **Bundled script** (if `scripts/litsearch.py` sits next to this file and you can run Python): standard library only, no key needed.
   - `python3 scripts/litsearch.py search "query 1" "query 2" "query 3" --cap 45 [--exclude PMID,PMID]` prints JSON: `source`, `per_query`, `notes`, `papers` (pmid, pmcid, doi, title, authors, journal, year, pub_types, abstract).
   - `python3 scripts/litsearch.py fulltext PMC1234567` prints the Methods and Results text of the open-access version, or `null`.
   - It falls back to Europe PMC automatically if PubMed fails.
2. **PubMed connector** (tools such as `search_articles`, `get_article_metadata`, `get_full_text_article`): run each query, fetch metadata and abstracts for the hits, and full text for papers that have a PMC id.
3. **NCBI E-utilities over HTTP** (curl or a fetch tool), no key needed, at most 3 requests per second:
   - search: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=20&term=(QUERY)+AND+hasabstract`
   - abstracts: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&retmode=xml&id=PMID1,PMID2`
   - full text: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&retmode=xml&id=PMCID_DIGITS` (keep only Methods and Results)
   - fallback: `https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&pageSize=25&query=(QUERY)+AND+HAS_ABSTRACT:y+AND+SRC:MED`
4. **Web search** restricted to pubmed.ncbi.nlm.nih.gov, only if none of the above work. Tell the user the answer rests on abstracts found by web search and is weaker.

If no tool can reach PubMed or Europe PMC, stop and say so. Do not answer from memory.

## Step 1. Orchestrator: plan the sub-questions

First list the distinct things the user wants to know, in their own terms. Then write 1 to 4 sub-questions that follow the question's own logic (for example "does it work?" and "how large is the effect?", or "what causes X?" and "can it be reversed?"). Do NOT split by scientific field.

- Use the fewest sub-questions that cover the ask: 1 for a narrow question, 2 to 3 when the user asks several distinct things, 4 only for broad multi-part questions. Sub-questions must not overlap.
- If the question asks "why" something happens but rests on a claim that may be false ("why does drug X increase Y?"), the first sub-question checks whether the claim is true. Add a mechanism sub-question only if the claim is likely true.
- Never add aspects the user did not ask about.

For each sub-question write:
- a 2 to 5 word **heading** in plain words ("Effect on heart attacks");
- the **evidence type** that answers it best, which picks the rubric below: `clinical` (patients, trials, cohorts), `lab` (mechanisms, cells, animal models) or `pharmacology` (targets, compounds, assays, potency);
- **3 PubMed queries** from different angles (synonyms, drug names, specific outcomes or mechanisms), 3 to 8 terms each with AND/OR. If you know landmark studies that answer it (named trials such as SELECT or ASPREE, or pivotal papers), make one query find them by name. Use tags like `randomized controlled trial[pt]` or `[tiab]` sparingly.

Show the user the plan in 2 to 3 first-person sentences ("You are asking two things: ... I will not look into ... because you did not ask about it.") and continue without waiting.

**Follow-ups.** If the user's new message only asks to explain, simplify, compare or reformat your previous LitPeer answer, and that answer already holds what is needed, skip the pipeline: answer briefly in prose from the earlier answer, keeping its citation numbers. If it needs new papers, rewrite it as a standalone question (resolve "it", "that drug") and run the full workflow.

## Step 2. One lane per sub-question

Run steps 2a to 2e for each sub-question. Lanes are independent; if you can run subagents, you may give each lane to one, passing it the sub-question, its evidence type, its queries, the rubric for that type, and steps 2a to 2e. Keep one shared reference list across lanes: number papers [1], [2], ... in the order they are first kept, and give a paper that shows up in two lanes the same number.

### 2a. Acquirer: search
Run the 3 queries and pool 30 to 50 unique candidates with abstracts.

### 2b. Screener: pick 5 to 8
From titles and abstracts, pick the 5 to 8 papers that best answer the sub-question, each with a reason of at most 18 words. Prefer:
- primary research that directly addresses it (trials, cohorts, experiments) over reviews, editorials and case reports;
- stronger designs for the evidence type (clinical: RCTs and meta-analyses of RCTs, larger samples; lab: in vivo mechanistic studies with clear methods; pharmacology: quantitative potency or efficacy data);
- landmark or pivotal studies when they are among the candidates, not only recent ones;
- a spread across the aspects of the sub-question, and recent work when quality is similar.

Then judge coverage. If it is thin (an important aspect has no good paper, or fewer than 5 picks), write ONE refined query for what is missing, search it (excluding PMIDs already seen), and re-screen the current picks plus the new candidates. Refine at most once per lane.

### 2c. Full text
For each pick that has a PMC id, fetch the open-access Methods and Results. Many papers have none; then work from the abstract and note "abstract only".

### 2d. Extractor: one paper at a time
Extract ONLY what the text states. Never infer numbers. Write "not reported" when a field is missing. Fields by evidence type:

- **clinical**: patients (population, condition); treatment (intervention and comparator); outcome (primary outcome and result, with effect size); size (number of participants); design (RCT, meta-analysis, cohort, case series, review...).
- **lab**: organism_model (organism, cell line or model system); method (main experimental methods); finding (key biological finding, with numbers).
- **pharmacology**: target (receptor, enzyme, pathway); compound; assay (assay or model); potency (IC50, EC50, Ki, % change... or "not reported").

Also record for every paper: `key_finding` (1 to 2 sentences answering the sub-question from this paper, with its main numbers, or "not relevant"), `evidence_quote` (a verbatim quote of at most 40 words that supports the key finding) and `relevant` (true or false).

### 2e. Evaluator: grade
Grade each paper's evidence for the sub-question with the rubric for its evidence type, add a relevance score (2 directly answers it, 1 partially, 0 not relevant) and a rationale of at most 20 words. Drop papers with relevance 0.

**clinical**
- A: meta-analysis of mainly RCTs, or a large RCT (roughly 300+ participants) with a clear primary outcome.
- B: smaller RCT, large prospective cohort adjusted for confounders, or a meta-analysis of mostly observational studies.
- C: retrospective, cross-sectional, small or uncontrolled study.
- D: case report, narrative review, editorial, or only loosely related.

**lab**
- A: in vivo (animal or human tissue) work with mechanistic evidence from more than one method and proper controls.
- B: in vivo model OR rigorous in vitro work with controls and quantitative results.
- C: single-method in vitro, computational only, or small exploratory study.
- D: review, commentary, or only loosely related.

**pharmacology**
- A: quantitative potency plus selectivity or in vivo efficacy, with a well-defined assay.
- B: quantitative in vitro potency from a defined assay, or clinical-stage pharmacology data.
- C: qualitative activity, docking or computational prediction only.
- D: review, patent-style summary, or only loosely related.

Give the user one progress line per lane: candidates screened, papers kept, how many read in full text, and the grade tally.

## Step 3. Synthesizer: draft the answer

Build an evidence table from the kept papers (number, grade, full text or abstract, title, year, extracted fields, key finding) and write the answer from that table only.

- **Bottom line**: 1 to 3 sentences that directly answer the whole question, with the key number if there is one. No background or preamble.
- **Sections**: 1 to 4, ordered by importance. The one that most directly answers the question comes first; subgroups, consistency and caveats come after. When the user asked separate things, each gets its own section in the order they asked. Group by point, not by paper or by field. Heading: 2 to 6 words in the user's terms, no numbering. Body: 2 to 4 flowing sentences of prose; use transitions, do not start sentences with "Paper [n]" or "One study".
- **Not answered by these papers**: one plain sentence per part of the question that got no answer. Usually empty. Never list things the user did not ask.
- **How strong is the evidence**: 1 to 2 sentences on the kinds of studies behind this answer (designs, grades, animal vs human, follow-up). No numbers here, since this part has no citations.
- **Premise note**: only when the question names a specific drug, trial, gene or study that none of the retrieved papers mention. Say plainly that no record of it was found in PubMed and the name may be wrong or it may not exist, then keep the answer very short.

Rules:
- Cite with [n] at the end of each sentence; every sentence in the bottom line and sections cites at least one paper that supports it.
- Prefer higher grades (A > B > C > D). Lead with the strongest human evidence. If the human evidence is mainly observational, small, mixed or only animal, the bottom line says so in plain words, even when a pooled analysis looks positive.
- If the question has a false premise, the first sentence corrects it, with citations.
- When the main point is that the evidence does not exist or the premise is false, keep the whole answer under 150 words with at most 2 sections.
- Give only the numbers that matter: usually the one or two headline results.
- Length: about 120 to 200 words for a narrow question, at most 350 for a broad one.
- Peer-reviewed research only. Never fill gaps from general knowledge.

## Step 4. Verifier: check every sentence, loop back

Go through the draft sentence by sentence and compare it with the cited papers' own text (abstract, full-text Results excerpt, and the evidence quotes). Be strict:
- **supported**: the cited text clearly states this, and numbers match;
- **partial**: broadly right but overstated, a wrong number, or missing a key qualifier (e.g. it was in mice);
- **unsupported**: the cited text does not say this, or the sentence has no valid citation.

If any sentence is partial or unsupported, revise: rewrite it so the cited paper supports it, cite the right paper, or remove it. Do not add new uncited claims, keep the same focus and order, and make sure each heading still matches what is under it (drop a section if nothing survives). Verify again. Stop after 3 drafts in total. In the final answer, remove any sentence still unsupported, and keep partial ones only after rewording them to match the source.

## Step 5. Deliver

Use this layout in Markdown:

```
**Bottom line.** <1-3 sentences with [n] citations>

### <Section heading>
<prose paragraph with [n] citations>

### <Section heading>
<prose paragraph>

**Not answered by these papers.** <sentences, or omit when empty>

**How strong is the evidence.** <1-2 sentences>

**References**
[1] Authors. Title. Journal, Year. Grade A, full text. https://pubmed.ncbi.nlm.nih.gov/PMID/
[2] ...

_Checked: <N> of <M> sentences supported after <R> verification round(s); <K> removed. Searched <source>; <X> candidates screened, <Y> papers kept._
```

List only papers cited in the answer, numbered in order of first citation (renumber if needed), each with its grade, whether it was read in full text or abstract only, and its PubMed link (or DOI link if there is no PMID). Offer once, in one line, to show the per-lane activity (queries, screening reasons, extraction tables, grades) if the user wants to see how the answer was built.
