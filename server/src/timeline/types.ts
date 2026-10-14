import type { ApprovedPageChunk, ISODate, TimelineDay } from "@adeno/contracts";

export type {
  ApprovedPageChunk, DayStatement, HistoryPage, ISODate, SourceReference,
  TimelineDay, TimelineDayIndexPage,
} from "@adeno/contracts";

export type AuthorizedScope = {
  householdId: string;
  userId: string;
};

export interface TimelineRepository {
  profileBelongsToHousehold(careProfileId: string, householdId: string): Promise<boolean>;
  /** Must return only days this active user may read; no hidden counts or cursors. */
  listApprovedDays(input: {
    householdId: string;
    userId: string;
    careProfileId: string;
    throughDay: ISODate;
    beforeDay?: ISODate;
    limit: number;
  }): Promise<TimelineDay[]>;
}

export type StoredPageChunk = Omit<ApprovedPageChunk, "sourceTextIsUntrusted">;

export interface ApprovedPageRepository {
  /** The adapter must authorize user, household, profile, document and source grant in one scoped read. */
  readApprovedPageChunk(input: {
    householdId: string;
    userId: string;
    careProfileId: string;
    documentId: string;
    pageNumber: number;
    offset: number;
    maxChars: number;
  }): Promise<StoredPageChunk | null>;
}

export type PendingReviewHint = { id: string; revisionId: string;
  targetCareDay: ISODate | null; createdAt: string };
export type PendingNoteHint = { revisionId: string; reviewRequestId: string | null;
  targetCareDay: ISODate; createdAt: string };

/** Private proposal for human review; excluded from ordinary history/MCP. */
export type NoteReviewDetail = {
  revisionId: string; careDay: ISODate; body: string;
  authorLabel: string; createdAt: string; expectedDayRevision: number;
  attribution: "family_note"; state: "proposed";
};

export interface NoteReviewRepository {
  /** Recheck active adult reviewer and publish rights in the same scoped read. */
  readPendingNote(input: {
    householdId: string; userId: string; careProfileId: string; revisionId: string;
  }): Promise<NoteReviewDetail | null>;
}

export type DocumentDayReviewDetail = {
  revisionId: string; careDay: ISODate; documentId: string; displayName: string;
  sourceSha256: string; pageCount: number; authorLabel: string;
  createdAt: string; expectedDayRevision: number; state: "proposed";
};
export interface DocumentDayReviewRepository {
  /** Scoped active adult, source access and day-publish permission in one read. */
  readPendingDocumentDay(input: {
    householdId: string; userId: string; careProfileId: string; revisionId: string;
  }): Promise<DocumentDayReviewDetail | null>;
}
export type DocumentInboxCursor = { uploadedAt: number; documentId: string };
export type InboxDocument = {
  documentId: string; displayName: string; sourceSha256: string;
  mediaType: "application/pdf" | "image/png" | "image/jpeg"; byteSize: number;
  pageCount: number; uploadedAt: string;
  pendingDayProposals: { revisionId: string; careDay: ISODate }[];
};
export interface DocumentInboxRepository {
  /** Adult owners see profile intake; current contributors see their own uploads. */
  listDocumentInbox(input: {
    householdId: string; userId: string; careProfileId: string; before?: DocumentInboxCursor;
  }): Promise<{ documents: InboxDocument[]; nextCursor: DocumentInboxCursor | null }>;
}
export type OriginalImageReference = {
  sourceSha256: string; byteSize: number; mediaType: "image/png" | "image/jpeg";
};
export interface OriginalImageRepository {
  /** Private review source: owner, current source grant, or own active intake. */
  readOriginalImageReference(input: {
    householdId: string; userId: string; careProfileId: string; documentId: string;
  }): Promise<OriginalImageReference | null>;
}
export interface ApprovedImageRepository {
  /** Source grant and a currently visible published snapshot are both required. */
  readApprovedImageReference(input: {
    householdId: string; userId: string; careProfileId: string; documentId: string;
  }): Promise<OriginalImageReference | null>;
}

export interface PendingReviewRepository {
  /** No proposal content is returned; reviewer authority is rechecked on every call. */
  listPendingChildReviews(input: {
    householdId: string; userId: string; careProfileId: string;
  }): Promise<PendingReviewHint[]>;
  listPendingNoteReviews(input: {
    householdId: string; userId: string; careProfileId: string;
  }): Promise<PendingNoteHint[]>;
}

export type DayVersion = { revision: number; publishedAt: string;
  publisherUserId: string; reason: string | null; contentSha256: string };

export interface DayVersionRepository {
  listDayVersions(input: { householdId: string; userId: string;
    careProfileId: string; careDay: ISODate }): Promise<DayVersion[]>;
  readDayVersion(input: { householdId: string; userId: string;
    careProfileId: string; careDay: ISODate; revision: number }): Promise<TimelineDay | null>;
}

export type VisibleCareProfile = { id: string; preferredName: string };

export interface CareProfileRepository {
  /** List only profiles for which this active member currently has a capability. */
  listVisibleCareProfiles(input: { householdId: string; userId: string }):
    Promise<VisibleCareProfile[]>;
}
