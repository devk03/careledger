import { Github, Star } from "lucide-react";
import { useEffect, useState } from "react";

export function GitHubLink() {
  const [stars, setStars] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 4000);
    fetch("/api/public/project", { credentials: "same-origin", signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then((value: { stars?: unknown; stale?: boolean } | null) => {
        if (controller.signal.aborted) return;
        if (typeof value?.stars === "number" && Number.isSafeInteger(value.stars) && value.stars >= 0) {
          setStars(value.stars); setStale(value.stale === true);
        }
      }).catch(() => { /* Keep the repository link usable without a count. */ })
      .finally(() => window.clearTimeout(timeout));
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, []);
  return <a className="github-link" href="https://github.com/devk03/careledger"
    target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
    aria-label={`Adeno on GitHub${stars === null ? "" : `, ${stars} stars${stale ? ", last known count" : ""}`}`}
    title={stars === null ? "View Adeno's open-source repository" : stale ? "Last known GitHub star count; refresh temporarily unavailable" : "GitHub stars · refreshed at most hourly"}>
    <Github size={17} aria-hidden="true" /><span>GitHub</span>
    {stars !== null && <span className="github-stars"><Star size={14} aria-hidden="true" />{stars.toLocaleString("en-US")}{stale ? "*" : ""}</span>}
  </a>;
}
