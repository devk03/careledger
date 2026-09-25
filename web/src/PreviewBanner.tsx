import { useEffect, useState } from "react";

export function PreviewBanner({ placement = "site" }: { placement?: "site" | "upload" }) {
  // A failed or unavailable status request must not hide the preview warning.
  const [restrictedPreview, setRestrictedPreview] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    Promise.resolve().then(() => fetch("/api/public/runtime", { credentials: "same-origin", signal: controller.signal }))
      .then(response => response.ok ? response.json() : null)
      .then((value: { restricted_preview?: unknown } | null) => {
        if (!controller.signal.aborted && value?.restricted_preview === false) {
          setRestrictedPreview(false);
        }
      })
      .catch(() => { /* Keep the warning visible if the mode cannot be verified. */ });
    return () => controller.abort();
  }, []);

  if (!restrictedPreview) return null;
  return <aside className={`preview-safety-banner${placement === "upload" ? " preview-safety-banner-inline" : ""}`}
    aria-label={placement === "upload" ? "Preview upload warning" : "Preview safety notice"}>
    <span>Restricted community preview · fictional records only.</span>
    <span>This installation is not end-to-end encrypted. <a href="/privacy">Read the privacy model</a>.</span>
  </aside>;
}
