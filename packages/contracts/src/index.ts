import type { AccessActor } from "./familyAccessWire.js";
import type { EntryProvenance, DocumentProvenance } from "./provenanceWire.js";
/** Wire-level data only. Authorization and persistence interfaces stay server-side. */
export * from "./dayKeyEnvelopeWire.js";
export * from "./scopeKeyEnvelopeWireV2.js";
export * from "./scopeEnvelopeActionV1.js";
export * from "./scopeEnvelopeBackfillActionV1.js";
export * from "./pendingDraftPairActionV1.js";
export * from "./managedVaultWireV2.js";
export * from "./indexHeadWire.js";
export * from "./sessionDeviceBindingProofV1.js";
export * from "./sessionDeviceBindingWireV1.js";
export * from "./deviceEnrollmentProofV1.js";
export * from "./deviceApprovalCodeV1.js";
export type ISODate = string;

export type SourceReference = {
  documentId: string;
  displayName: string;
  uploadedAt: string;
  sourceSha256: string;
  mediaType?: "application/pdf" | "image/png" | "image/jpeg";
  pageNumbers: number[];
  provenance?: DocumentProvenance;
};

export type DayStatement = {
  id: string;
  text: string;
  attribution: "document" | "family_note";
  authorLabel?: string;
  provenance?: EntryProvenance;
  status: "planned" | "occurred" | "cancelled" | "uncertain";
  sourceDocumentId?: string;
  pageNumber?: number;
};

export type TimelineDay = {
  id: string;
  careProfileId: string;
  day: ISODate;
  sources: SourceReference[];
  statements: DayStatement[];
  revision: number;
  publishedBy?: AccessActor;
  publishedAt?: string;
};

export type HistoryPage = {
  throughDay: ISODate;
  focusFromDay: ISODate | null;
  days: TimelineDay[];
  nextBeforeDay: ISODate | null;
  meaning: "currently_recorded_history";
};

export type TimelineDayIndexPage = {
  throughDay: ISODate;
  days: { id: string; day: ISODate; fileCount: number; revision: number }[];
  nextBeforeDay: ISODate | null;
};

export type ApprovedPageChunk = {
  documentId: string;
  pageNumber: number;
  sourceSha256: string;
  offset: number;
  text: string;
  nextOffset: number | null;
  sourceTextIsUntrusted: true;
};
export type { AccessActor, FamilyAccessOverview } from "./familyAccessWire.js";
export type { EntryProvenance, DocumentProvenance } from "./provenanceWire.js";
export type { NoteProvenanceInput } from "./noteProvenanceWire.js";
