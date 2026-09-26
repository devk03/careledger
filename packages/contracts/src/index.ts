/** Wire-level data only. Authorization and persistence interfaces stay server-side. */
export * from "./dayKeyEnvelopeWire.js";
export * from "./scopeKeyEnvelopeWireV2.js";
export * from "./scopeEnvelopeActionV1.js";
export * from "./scopeEnvelopeBackfillActionV1.js";
export * from "./managedVaultWireV2.js";
export * from "./indexHeadWire.js";
export * from "./sessionDeviceBindingProofV1.js";
export type ISODate = string;

export type SourceReference = {
  documentId: string;
  displayName: string;
  uploadedAt: string;
  sourceSha256: string;
  pageNumbers: number[];
};

export type DayStatement = {
  id: string;
  text: string;
  attribution: "document" | "family_note";
  authorLabel?: string;
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
