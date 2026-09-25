import type { Plugin } from "vite";

/** No record/backend access. Only fixed public GitHub metadata can leave this server. */
export function uiPreview(): Plugin {
  let stats: { stars: number | null; checked_at: number | null; stale: boolean } = { stars: null, checked_at: null, stale: false };
  let refreshAt = 0;
  async function publicStars() {
    if (Date.now() < refreshAt) return stats;
    refreshAt = Date.now() + 300_000;
    try {
      const response = await fetch("https://api.github.com/repos/devk03/careledger", {
        headers: { "Accept": "application/vnd.github+json", "User-Agent": "Adeno-public-stars" },
        redirect: "error", signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error("Public metadata unavailable");
      const value = await response.json() as { stargazers_count?: unknown };
      if (typeof value.stargazers_count !== "number" || !Number.isSafeInteger(value.stargazers_count) || value.stargazers_count < 0) throw new Error("Invalid count");
      stats = { stars: value.stargazers_count, checked_at: Math.floor(Date.now() / 1000), stale: false };
      refreshAt = Date.now() + 3_600_000;
    } catch { stats = { ...stats, stale: true }; }
    return stats;
  }
  const profile = { id: "synthetic-profile", preferred_name: "Demo family (fictional)", created_at: 0 };
  const question = { id: "demo-question", text: "What should we bring to the sample appointment?", priority: "at_next_visit", state: "open", due_date: null };
  const payloads: Record<string, unknown> = {
    "/api/system/setup-status": { setup_required: true, ai_available: false },
    "/api/public/runtime": { restricted_preview: true },
    "/api/auth/session": { authenticated: true, csrf_token: "synthetic-not-valid", user: { display_name: "Demo caregiver", role: "owner" } },
    "/api/ai/status": { enabled: false, provider: "disabled", model: null, external_transfer_required: false },
    "/api/care-profiles": [profile],
    "/api/care-profiles/synthetic-profile/documents": [{
      id: "synthetic-record", display_name: "SYNTHETIC — sample appointment note",
      media_type: "application/pdf", source_sha256: "0".repeat(64), byte_size: 1024,
      page_count: 1, status: "ready", scan_verdict: "clean", duplicate_source: false,
    }],
    "/api/care-profiles/synthetic-profile/workspace": {
      profile_id: profile.id, preferred_name: profile.preferred_name,
      what_we_know: [], what_this_means: [], what_remains_unknown: [], timeline: [],
      questions: [question], followups: [{ id: "demo-followup", title: "Confirm the sample appointment time zone", source: "caregiver_task", state: "open", due_date: null }], decisions: [],
    },
  };
  return {
    name: "adeno-isolated-synthetic-preview",
    transformIndexHtml(html) {
      return html.replace('<div id="root">', '<div class="ui-preview-banner">SYNTHETIC UI PREVIEW — NOT REAL PATIENT DATA. Forms cannot save or call AI. <a href="/design-system">Component library</a></div><div id="root">');
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0];
        if (!path.startsWith("/api/") && !path.startsWith("/health")) return next();
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: "SYNTHETIC_PREVIEW_READ_ONLY" }));
          return;
        }
        if (path === "/api/public/project") {
          void publicStars().then(value => res.end(JSON.stringify(value)));
          return;
        }
        res.statusCode = path in payloads ? 200 : 404;
        res.end(JSON.stringify(payloads[path] ?? { error: "SYNTHETIC_PREVIEW_ONLY" }));
      });
    },
  };
}
