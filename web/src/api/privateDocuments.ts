export type InboxCursor = { uploadedAt: number; documentId: string };
export type InboxDocument = {
  documentId: string; displayName: string; sourceSha256: string;
  mediaType: "application/pdf" | "image/png" | "image/jpeg"; byteSize: number;
  pageCount: number; uploadedAt: string;
  pendingDayProposals: { revisionId: string; careDay: string }[];
};
export type DocumentDayProposal = {
  revisionId: string; careDay: string; documentId: string; displayName: string;
  sourceSha256: string; pageCount: number; authorLabel: string;
  createdAt: string; expectedDayRevision: number; state: "proposed";
};
export class DocumentWorkflowError extends Error {
  constructor(readonly status: number | null, readonly unconfirmed: boolean) {
    super(unconfirmed ? "The result is unconfirmed. Refresh the inbox before trying again."
      : status === 409 ? "The proposal or day changed. Refresh and review it again."
        : status === 401 ? "Please sign in again." : "The document request could not be completed.");
  }
}
const base = (profileId: string) => `/api/v2/care-profiles/${encodeURIComponent(profileId)}`;
export function originalImageUrl(profileId: string, documentId: string, sha256: string) {
  return `${base(profileId)}/documents/${encodeURIComponent(documentId)}/original-image?expectedSha256=${encodeURIComponent(sha256)}`;
}
export function getDocumentWorkflowCapabilities(signal?: AbortSignal) {
  return request<{ available: boolean }>("/api/v2/document-workflow/capabilities", signal ? { signal } : {});
}
async function request<T>(path: string, options: { signal?: AbortSignal; csrfToken?: string; body?: unknown } = {}): Promise<T> {
  const mutation = options.body !== undefined;
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", cache: "no-store",
      ...(options.signal ? { signal: options.signal } : {}),
      ...(mutation ? { method: "POST", headers: { "content-type": "application/json",
        "x-csrf-token": options.csrfToken ?? "" }, body: JSON.stringify(options.body) } : {}) });
  } catch { throw new DocumentWorkflowError(null, mutation); }
  if (!response.ok) throw new DocumentWorkflowError(response.status, mutation && response.status >= 500);
  try { return await response.json() as T; }
  catch { throw new DocumentWorkflowError(response.status, mutation); }
}
export function listDocumentInbox(profileId: string, before?: InboxCursor, signal?: AbortSignal) {
  const query = before ? `?${new URLSearchParams({ beforeUploadedAt: String(before.uploadedAt), beforeDocumentId: before.documentId })}` : "";
  return request<{ documents: InboxDocument[]; nextCursor: InboxCursor | null }>(`${base(profileId)}/documents/inbox${query}`,
    signal ? { signal } : {});
}
export function proposeDocumentDay(profileId: string, documentId: string, careDay: string, csrfToken: string) {
  return request<{ ok: true; placementId: string; revisionId: string; reviewRequestId: string | null }>(
    `${base(profileId)}/documents/${encodeURIComponent(documentId)}/day-proposals`, { csrfToken, body: { careDay } });
}
export function readDocumentDayProposal(profileId: string, revisionId: string, signal?: AbortSignal) {
  return request<DocumentDayProposal>(`${base(profileId)}/reviews/document-days/${encodeURIComponent(revisionId)}`, signal ? { signal } : {});
}
export function reviewDocumentDayProposal(profileId: string, proposal: Pick<DocumentDayProposal, "revisionId" | "expectedDayRevision">,
  decision: "accepted" | "rejected", csrfToken: string) {
  return request<{ ok: true; snapshotId: string | null; revision: number }>(
    `${base(profileId)}/timeline/document-days/${encodeURIComponent(proposal.revisionId)}/review`,
    { csrfToken, body: { decision, expectedDayRevision: proposal.expectedDayRevision } });
}
