/** Browser-only access inventory. This does not grant access or expose credentials. */
export type AccessActor = { userId: string; displayName: string };
export type FamilyAccessOverview = {
  visibility: "household" | "self";
  currentUserId: string;
  profiles: { id: string; preferredName: string }[];
  members: {
    id: string; displayName: string; role: "owner" | "caregiver";
    memberKind: "adult" | "child"; status: "active" | "pending" | "disabled";
    allProfiles: boolean;
    intakeProfiles: string[];
    days: { careProfileId: string; careDay: string; level: "view" | "contribute" | "publish";
      grantedBy: AccessActor; grantedAt: string }[];
    documents: { careProfileId: string; documentId: string; displayName: string;
      basis: "explicit_grant" | "own_upload"; grantedBy?: AccessActor; grantedAt?: string }[];
  }[];
};
