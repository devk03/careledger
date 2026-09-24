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
