import { useEffect, useState } from "react";

export function PreviewBanner({ placement = "site" }: { placement?: "site" | "upload" }) {
  // A failed or unavailable status request must not hide the preview warning.
  const [restrictedPreview, setRestrictedPreview] = useState(true);
  const [trustedPrivate, setTrustedPrivate] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    Promise.resolve().then(() => fetch("/api/public/runtime", { credentials: "same-origin", signal: controller.signal }))
      .then(response => response.ok ? response.json() : null)
      .then((value: { restricted_preview?: unknown; mode?: unknown } | null) => {
        if (!controller.signal.aborted && value?.restricted_preview === false) {
          setRestrictedPreview(false);
          setTrustedPrivate(value.mode === "trusted_private");
        }
      })
      .catch(() => { /* Keep the warning visible if the mode cannot be verified. */ });
    return () => controller.abort();
  }, []);

  return <aside className={`preview-safety-banner${placement === "upload" ? " preview-safety-banner-inline" : ""}`}
    aria-label={restrictedPreview
      ? (placement === "upload" ? "Preview upload warning" : "Preview safety notice")
      : (placement === "upload" ? "Upload privacy notice" : "Record privacy notice")}>
    <span>{restrictedPreview
      ? "Restricted community preview · fictional records only."
      : trustedPrivate ? "Private Hermes workspace · records are server-readable."
      : "Community edition · records are server-readable."}</span>
    <span>{restrictedPreview
      ? "This installation is not end-to-end encrypted."
      : "This is not end-to-end encrypted. Add personal records only to a server you trust."} <a href={trustedPrivate ? "/pilot/privacy" : "/privacy"}>Read the privacy model</a>.</span>
  </aside>;
}
