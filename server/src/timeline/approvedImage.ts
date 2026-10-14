import type { ApprovedImageReader, ApprovedImageRepository } from "./types.js";
import { readOriginalImage } from "../ingest/readOriginalImage.js";
import { parseImageRendition, type ImageRenditionResult } from "../ingest/imageRenditionProtocol.js";

/** Private file verification and isolated rendering never authorize an unpublished source. */
export function createApprovedImageReader(input: {
  repository: ApprovedImageRepository; objectRoot: string;
  render: (bytes: Uint8Array, mediaType: "image/png" | "image/jpeg") => Promise<ImageRenditionResult>;
}): ApprovedImageReader {
  let active = false;
  return { async readApprovedImage(query) {
    if (active) return null;
    active = true;
    const scope = Object.freeze({ ...query });
    try {
      const reference = await input.repository.readApprovedImageReference(scope);
      if (!reference) return null;
      const bytes = await readOriginalImage(input.objectRoot, reference);
      const result = parseImageRendition(await input.render(bytes, reference.mediaType), reference.sourceSha256);
      if (result.verdict !== "safe") return null;
      const current = await input.repository.readApprovedImageReference(scope);
      if (!current || current.sourceSha256 !== reference.sourceSha256 || current.byteSize !== reference.byteSize || current.mediaType !== reference.mediaType)
        return null;
      return result;
    } catch { return null; }
    finally { active = false; }
  } };
}
