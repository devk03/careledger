import { z } from "zod";
export const noteProvenanceInput = z.object({
  reporterLabel: z.string().trim().min(1).max(120).optional(),
  sourceKind: z.enum(["family_observation", "clinician_communication", "document", "research_context", "unknown"]),
  sourceDescription: z.string().trim().min(1).max(1000).optional(),
  documentId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  pageNumber: z.number().int().min(1).max(1000).optional(),
}).strict().refine(value => (value.documentId === undefined) === (value.pageNumber === undefined), "File and page must be supplied together")
  .refine(value => value.sourceKind !== "document" || value.documentId !== undefined, "Document source requires a file and page");
