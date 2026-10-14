import { z } from "zod/v4";
import { createTimelineMcpServer } from "./server.js";
import type { ApprovedPageRepository, AuthorizedScope, CareProfileRepository,
  PendingReviewRepository, TimelineRepository } from "../timeline/types.js";

/** Pins the approved identity; every repository operation reloads authorization. */
export async function createAuthorizedTimelineMcpServer(input: {
  authorize: () => Promise<AuthorizedScope | null>;
  timeline: TimelineRepository; pages: ApprovedPageRepository;
  profiles?: CareProfileRepository; reviews?: PendingReviewRepository;
}) {
  const initial = await input.authorize();
  if (!initial) throw new Error("AUTH_REQUIRED");
  const scope = Object.freeze({ ...initial });
  async function read<T>(operation: () => Promise<T>): Promise<T> {
    let current: AuthorizedScope | null;
    try { current = await input.authorize(); }
    catch { throw new Error("AUTH_REQUIRED"); }
    if (!current || current.userId !== scope.userId || current.householdId !== scope.householdId)
      throw new Error("AUTH_REQUIRED");
    try { return await operation(); }
    catch { throw new Error("READ_UNAVAILABLE"); }
  }
  const timeline: TimelineRepository = {
    profileBelongsToHousehold: (profileId) => read(() => input.timeline.profileBelongsToHousehold(profileId, scope.householdId)),
    listApprovedDays: query => read(() => input.timeline.listApprovedDays({ ...query, ...scope })),
  };
  const pages: ApprovedPageRepository = {
    readApprovedPageChunk: query => read(() => input.pages.readApprovedPageChunk({ ...query, ...scope })),
  };
  const profiles: CareProfileRepository | undefined = input.profiles ? {
    listVisibleCareProfiles: () => read(() => input.profiles!.listVisibleCareProfiles(scope)),
  } : undefined;
  const reviews: PendingReviewRepository | undefined = input.reviews ? {
    listPendingChildReviews: query => read(() => input.reviews!.listPendingChildReviews({ ...query, ...scope })),
    listPendingNoteReviews: query => read(() => input.reviews!.listPendingNoteReviews({ ...query, ...scope })),
  } : undefined;
  const server = createTimelineMcpServer({ scope, timeline, pages,
    ...(profiles ? { profiles } : {}), ...(reviews ? { reviews } : {}) });
  server.registerTool("get_connection_profile", {
    description: "Verify this individually approved, read-only Hermes connection. This private installation is server-readable; selected tool results reach this AI client.",
    inputSchema: z.object({}),
  }, async () => {
    const profile = await read(async () => ({ accountId: scope.userId, householdId: scope.householdId,
      scopes: ["approved_history:read", "approved_source:read"], transport: "ssh_stdio",
      storagePrivacy: "trusted_server_readable", selectedClientReceivesPlaintext: true }));
    return { content: [{ type: "text" as const, text: JSON.stringify(profile) }] };
  });
  return server;
}
