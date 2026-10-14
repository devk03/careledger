export type IntakeCapabilities = { available: boolean; mediaTypes: string[]; maxBytes: number };
export type UploadReceipt = { documentId: string; alreadyExisted: boolean };

/** Network failure is uncertain: the server may already have committed metadata. */
export class UnconfirmedUpload extends Error {
  constructor() { super("The upload result is unconfirmed. Keep the original file and check its intake status before retrying."); }
}

export async function uploadPrivateImage(input: {
  profileId: string; csrfToken: string; file: File; capabilities: IntakeCapabilities;
}): Promise<UploadReceipt> {
  const { file, capabilities } = input;
  if (!capabilities.available) throw new Error("Image intake is unavailable on this installation.");
  if (!capabilities.mediaTypes.includes(file.type)) throw new Error("This file type is not supported. Use a PNG or JPEG image.");
  if (file.size < 1 || file.size > capabilities.maxBytes) throw new Error("The image is empty or exceeds the upload limit.");
  let response: Response;
  try {
    response = await fetch(`/api/v2/care-profiles/${encodeURIComponent(input.profileId)}/documents`, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": file.type, "x-upload-name": encodeURIComponent(file.name),
        "x-csrf-token": input.csrfToken }, body: file,
    });
  } catch { throw new UnconfirmedUpload(); }
  if (response.status >= 500) throw new UnconfirmedUpload();
  if (!response.ok) throw new Error(response.status === 401 ? "Sign in again before uploading."
    : response.status === 413 ? "The image exceeds the upload limit."
    : response.status === 415 ? "This file type is not supported."
    : response.status === 422 ? "The file did not pass inspection."
    : response.status === 429 ? "Another upload is running. Try again when it finishes."
    : "The server did not accept this upload.");
  try {
    const receipt: unknown = await response.json();
    if (typeof receipt !== "object" || receipt === null ||
      typeof (receipt as UploadReceipt).documentId !== "string" ||
      typeof (receipt as UploadReceipt).alreadyExisted !== "boolean") throw new Error("Invalid receipt");
    return receipt as UploadReceipt;
  } catch { throw new UnconfirmedUpload(); }
}
