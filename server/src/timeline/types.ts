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
  listApprovedDays(input: {
    householdId: string;
    careProfileId: string;
    throughDay: ISODate;
    beforeDay?: ISODate;
    limit: number;
  }): Promise<TimelineDay[]>;
}

export type StoredPageChunk = Omit<ApprovedPageChunk, "sourceTextIsUntrusted">;

export interface ApprovedPageRepository {
  /** The adapter must authorize the household/profile/document/link in one scoped read. */
  readApprovedPageChunk(input: {
    householdId: string;
    careProfileId: string;
    documentId: string;
    pageNumber: number;
    offset: number;
    maxChars: number;
  }): Promise<StoredPageChunk | null>;
}
