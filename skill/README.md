# LitPeer research skill

A Claude skill that runs LitPeer's literature workflow inside Claude: Orchestrator (1-4 sub-questions) -> one lane per sub-question (Acquirer: search + screen + refine + full text; Extractor; Evaluator) -> Synthesizer <-> Verifier.

## Install

- **Claude.ai / Claude desktop:** Settings > Capabilities > Skills > Upload skill, and choose `litpeer-research.zip`.
- **Claude Code:** copy the `litpeer-research/` folder to `~/.claude/skills/` (personal) or `.claude/skills/` in a project.

Then ask a question such as "What does the evidence say about semaglutide and heart attacks in people without diabetes?"

## Needs

- Network access to PubMed (eutils.ncbi.nlm.nih.gov) or Europe PMC (www.ebi.ac.uk), or the PubMed connector.
- Python 3 for `scripts/litsearch.py` (standard library only). Optional: `NCBI_API_KEY` for a higher rate limit.
- No DeepSeek or other API key: Claude does the reasoning itself.
