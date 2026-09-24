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
