export function publicReleaseRevision(candidate: string | undefined): string | null {
  return candidate && /^[0-9a-f]{40}$/.test(candidate) ? candidate : null;
}
