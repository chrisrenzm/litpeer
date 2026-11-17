// Evidence-type extraction schemas and grading rubrics used by the Screener,
// Extractor and Evaluator agents. The Orchestrator splits a question by its own
// logic; each sub-question is only tagged with the kind of study that answers it
// (lab, clinical or pharmacology) so papers are graded by the right standard.
// Keys are kept as biology / healthcare / drug_discovery for compatibility.

export const FIELDS = {
  biology: {
    label: "Lab studies",
    extract: {
      organism_model: "Organism, cell line or model system studied",
      method: "Main experimental methods",
      finding: "Key biological finding, with numbers if given",
    },
    rubric: `A: in vivo (animal or human tissue) work with mechanistic evidence from more than one method and proper controls.
B: in vivo model OR rigorous in vitro work with controls and quantitative results.
C: single-method in vitro, computational only, or small exploratory study.
D: review, commentary, or only loosely related to the sub-question.`,
  },
  healthcare: {
    label: "Clinical studies",
    extract: {
      patients: "Who was studied (population, condition)",
      treatment: "Intervention and comparator",
      outcome: "Primary outcome and result, with effect size if given",
      size: "Number of participants (write 'not reported' if absent)",
      design: "Study design (RCT, meta-analysis, cohort, case series, review...)",
    },
    rubric: `A: meta-analysis of mainly RCTs, or a large RCT (roughly 300+ participants) reporting a clear primary outcome.
B: smaller RCT, large prospective cohort with adjustment for confounders, or a meta-analysis that pools mostly observational studies.
C: retrospective, cross-sectional, small or uncontrolled study.
D: case report, narrative review, editorial, or only loosely related.`,
  },
  drug_discovery: {
    label: "Pharmacology studies",
    extract: {
      target: "Molecular target (receptor, enzyme, pathway)",
      compound: "Compound(s) or drug candidate(s)",
      assay: "Assay or model used to test activity",
      potency: "Potency / efficacy metric (IC50, EC50, Ki, % change...) or 'not reported'",
    },
    rubric: `A: quantitative potency plus selectivity or in vivo efficacy, with a well-defined assay.
B: quantitative in vitro potency from a defined assay, or clinical-stage pharmacology data.
C: qualitative activity, docking or computational prediction only.
D: review, patent-style summary, or only loosely related.`,
  },
};

export const FIELD_KEYS = Object.keys(FIELDS);

export function normalizeField(f) {
  const s = String(f || "").toLowerCase().replace(/[\s-]+/g, "_");
  if (s.includes("drug") || s.includes("pharm")) return "drug_discovery";
  if (s.includes("bio") || s.includes("lab") || s.includes("mechan") || s.includes("animal")) return "biology";
  return FIELD_KEYS.includes(s) ? s : "healthcare";
}
