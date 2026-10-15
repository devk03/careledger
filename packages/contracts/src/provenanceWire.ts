import type { AccessActor } from "./familyAccessWire.js";
export type EntryProvenance = {
  recordedBy?: AccessActor;
  recordedAt?: string;
  reviewedBy?: AccessActor;
  reviewedAt?: string;
  /** Reporter is distinct from the account that entered the information. */
  reportedBy?: AccessActor;
  sourceKind?: string;
  citations?: { documentId: string; pageNumber: number }[];
};
export type DocumentProvenance = {
  uploadedBy?: AccessActor;
  recordDate?: string | null;
  recordDateText?: string | null;
  placement?: EntryProvenance;
};
