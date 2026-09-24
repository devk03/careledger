import type {
  ApprovedPageChunk,
  ApprovedPageRepository,
  AuthorizedScope,
  TimelineRepository,
} from "./types.js";

export class SourcePageNotFound extends Error {
  constructor() {
    super("Source page not found");
  }
}

export class InvalidPageRequest extends Error {
  constructor() {
    super("Invalid page or offset");
  }
}

export async function getApprovedSourcePage(
  repository: ApprovedPageRepository,
  timeline: TimelineRepository,
  scope: AuthorizedScope,
  input: {
    careProfileId: string;
    documentId: string;
    pageNumber: number;
    offset?: number;
  },
): Promise<ApprovedPageChunk> {
  const offset = input.offset ?? 0;
  if (!Number.isInteger(input.pageNumber) || input.pageNumber < 1 || input.pageNumber > 10_000 ||
    !Number.isInteger(offset) || offset < 0 || offset > 5_000_000) {
    throw new InvalidPageRequest();
  }

  if (!(await timeline.profileBelongsToHousehold(input.careProfileId, scope.householdId))) {
    throw new SourcePageNotFound();
  }

  const result = await repository.readApprovedPageChunk({
    householdId: scope.householdId,
    careProfileId: input.careProfileId,
    documentId: input.documentId,
    pageNumber: input.pageNumber,
    offset,
    maxChars: 6_000,
  });
  if (result === null) throw new SourcePageNotFound();
  if (result.documentId !== input.documentId || result.pageNumber !== input.pageNumber ||
    result.offset !== offset || result.text.length > 6_000 ||
    (result.nextOffset !== null &&
      (!Number.isInteger(result.nextOffset) || result.nextOffset <= offset || result.nextOffset > 5_000_000)) ||
    !/^[0-9a-f]{64}$/.test(result.sourceSha256)) {
    throw new Error("Approved page repository returned invalid data");
  }
  return { ...result, sourceTextIsUntrusted: true };
}
