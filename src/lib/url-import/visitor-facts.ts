// OPE-1506 — moved to @takemetothefair/utils so the MCP Worker can read visitor
// facts from an organizer EMAIL whose AI extraction failed. Re-exported so
// existing imports stand.
export {
  splitSentences,
  classifyPetSentence,
  findVisitorFacts,
  withVisitorFacts,
  VISITOR_FACT_MAX,
  type VisitorFacts,
  type VisitorFactExcerpt,
  type PetFactExcerpt,
} from "@takemetothefair/utils";
