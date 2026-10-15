export type NoteProvenanceInput = {
  reporterLabel?: string | undefined;
  sourceKind: "family_observation" | "clinician_communication" | "document" | "research_context" | "unknown";
  sourceDescription?: string | undefined;
  documentId?: string | undefined;
  pageNumber?: number | undefined;
};
