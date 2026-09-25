import { fileURLToPath } from "node:url";

export function validateReleaseSha(sha, releaseBuild) {
  if (releaseBuild !== "0" && releaseBuild !== "1")
    throw new Error("Release build mode must be 0 or 1.");
  if (!sha) {
    if (releaseBuild === "1") throw new Error("Release build requires a public source commit.");
    return null;
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Public source commit must be a full lowercase SHA.");
  return sha;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    validateReleaseSha(process.env.VITE_ADENO_RELEASE_SHA, process.env.ADENO_RELEASE_BUILD ?? "0");
    process.stdout.write("Public source revision build gate passed.\n");
  } catch {
    process.stderr.write("Public source revision build gate failed.\n");
    process.exitCode = 1;
  }
}
