import { ButtonLink } from "./ui";
import {
  ArrowRight,
  Check,
  FileText,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { useEffect, useState } from "react";

import { LoginPage } from "./LoginPage";
import { BackupPage } from "./BackupPage";
import { RecoveryPage } from "./RecoveryPage";
import { RecordsPage } from "./RecordsPage";
import { SetupPage } from "./SetupPage";
import { WorkspacePage } from "./WorkspacePage";
import { DesignSystemPage } from "./DesignSystemPage";
import { EditorialArt } from "./EditorialArt";
import { GitHubLink } from "./GitHubLink";
import { PublicFooter, InformationPage, CaregiverExamples } from "./InformationPage";

type SetupStatus = {
  setup_required: boolean;
  ai_available: boolean;
};

const journey = [
  {
    number: "01",
    title: "Add the records",
    body: "Upload PDFs or photos. Adeno keeps the original files unchanged and checks for duplicates.",
  },
  {
    number: "02",
    title: "Check what was found",
    body: "Plain-language notes sit beside the exact page they came from. You approve what belongs in the case.",
  },
  {
    number: "03",
    title: "Walk into the next visit ready",
    body: "See open questions, promised follow-ups, and a short appointment brief without rereading every report.",
  },
];

function LandingPage() {
  const [setup, setSetup] = useState<SetupStatus | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/system/setup-status", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(response)))
      .then((value: SetupStatus) => setSetup(value))
      .catch(() => setSetup({ setup_required: true, ai_available: false }));
    return () => controller.abort();
  }, []);

  return (
    <div className="app-shell welcome-page">
      <header className="welcome-topbar">
        <a className="wordmark" href="#top" aria-label="Adeno home">
          Adeno
        </a>
        <nav aria-label="Welcome navigation">
          <a href="#how-it-works">How it works</a>
          <a href="/login">Sign in</a>
          <GitHubLink />
        </nav>
      </header>

      <main id="top">
        <section className="welcome welcome-editorial" aria-labelledby="welcome-title">
          <div className="welcome-copy">
            <p className="context-line">For the people caring for someone.</p>
            <h1 id="welcome-title">Know what is happening. Know what to ask next.</h1>
            <p className="lede">
              Adeno turns a pile of health records into a source-linked timeline, gentle
              explanations, and a clear list for the next doctor visit.
            </p>
            <div className="welcome-actions">
              <ButtonLink className="" href={setup?.setup_required ? "/setup" : "/records"}>
                {setup?.setup_required ? "Finish private setup" : "Add health records"}
                <ArrowRight aria-hidden="true" size={18} />
              </ButtonLink>
              <a className="text-link" href="#how-it-works">
                See how it works
              </a>
            </div>
            <p className="safety-note">
              <LockKeyhole aria-hidden="true" size={16} />
              For personal understanding and organization—not medical advice, diagnosis, or treatment.
            </p>
          </div>

          <EditorialArt className="welcome-art" priority />
        </section>

        <section className="welcome-start" aria-labelledby="next-panel-title">
          <aside className="next-panel">
            <div className="next-panel-heading">
              <span className="status-dot" aria-hidden="true" />
              <p>Start here</p>
            </div>
            <h2 id="next-panel-title">Set up your family workspace</h2>
            <p>
              Create the owner account using your administrator’s setup link, then add one record.
              Proposed notes enter your reviewed timeline after you approve them; approval does not verify medical accuracy.
            </p>
            <ol className="setup-list">
              <li>
                <span className="step-marker">1</span>
                <span>Create the private owner account</span>
              </li>
              <li>
                <span className="step-marker">2</span>
                <span>Add a PDF or a clear photo</span>
              </li>
              <li>
                <span className="step-marker">3</span>
                <span>Review each proposed note beside its source</span>
              </li>
            </ol>
            <div className="system-line">
              <ShieldCheck aria-hidden="true" size={17} />
              <span>
                {setup?.ai_available
                  ? "Plain-language explanations are ready"
                  : "Explanations are off for now"}
              </span>
            </div>
          </aside>
        </section>

        <section className="empty-workbench" aria-labelledby="workbench-title">
          <div className="workbench-intro">
            <p className="section-note">A look inside the workspace</p>
            <h2 id="workbench-title">One calm view, with the evidence close by.</h2>
            <p>
              The dashboard stays short on purpose. Open the source whenever you need the exact
              wording.
            </p>
          </div>

          <div className="workbench-frame">
            <nav className="rail" aria-label="Workspace sections">
              <a className="rail-item rail-item-active" href="#summary" aria-current="page">
                <FileText aria-hidden="true" size={18} />
                Summary
              </a>
              <a className="rail-item" href="/records">
                <Upload aria-hidden="true" size={18} />
                Records
              </a>
              <a className="rail-item" href="/workspace#next-steps">
                <Check aria-hidden="true" size={18} />
                Next steps
              </a>
            </nav>

            <div className="brief" id="summary">
              <div className="brief-header">
                <div>
                  <p className="brief-label">Family brief</p>
                  <h3>No records yet</h3>
                </div>
                <ButtonLink variant="secondary" href="/records">
                  <Plus aria-hidden="true" size={17} />
                  Add record
                </ButtonLink>
              </div>

              <div className="brief-sections">
                <article>
                  <h4>What we know</h4>
                  <p>Reviewed facts from records and family updates will appear here.</p>
                </article>
                <article>
                  <h4>What this means</h4>
                  <p>Available plain-language explanations link back to the record they describe.</p>
                </article>
                <article>
                  <h4>What remains unknown</h4>
                  <p>Missing results and unresolved questions will stay visible instead of being guessed.</p>
                </article>
                <article className="next-article">
                  <h4>What to do next</h4>
                  <p>Tasks will show who owns them, when they are due, and whether a clinician requested them.</p>
                </article>
              </div>
            </div>

            <aside className="source-preview" aria-label="Source preview placeholder">
              <div className="paper-preview" aria-hidden="true">
                <div className="paper-rule paper-rule-short" />
                <div className="paper-rule" />
                <div className="paper-rule" />
                <div className="paper-gap" />
                <div className="paper-rule" />
                <div className="paper-rule paper-rule-medium" />
              </div>
              <p>Illustrative empty workspace. In your workspace, open a record to read its original pages.</p>
            </aside>
          </div>
        </section>

        <section className="journey" id="how-it-works" aria-labelledby="journey-title">
          <div className="journey-heading">
            <p className="section-note">How it works</p>
            <h2 id="journey-title">The record stays the record. The explanation stays an explanation.</h2>
          </div>
          <div className="journey-list">
            {journey.map((item) => (
              <article key={item.number}>
                <span>{item.number}</span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </div>
              </article>
            ))}
          </div>
          <EditorialArt scene="notes" className="journey-art" />
        </section>

        <CaregiverExamples />

        <section className="trust-strip" aria-label="Safety principles">
          <p>
            <ShieldCheck aria-hidden="true" size={18} />
            Built for careful families, not for replacing medical care.
          </p>
          <ButtonLink variant="quiet" href="/privacy">
            Read the privacy model
            <ArrowRight aria-hidden="true" size={17} />
          </ButtonLink>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}

function App() {
  if (window.location.pathname === "/privacy" || window.location.pathname === "/about") {
    return <InformationPage page={window.location.pathname === "/privacy" ? "privacy" : "about"} />;
  }
  if (import.meta.env.DEV && window.location.pathname === "/design-system") {
    return <DesignSystemPage />;
  }
  if (window.location.pathname === "/setup") {
    return <SetupPage />;
  }
  if (window.location.pathname === "/login") {
    return <LoginPage />;
  }
  if (window.location.pathname === "/recover") {
    return <RecoveryPage />;
  }
  if (window.location.pathname === "/records") {
    return <RecordsPage />;
  }
  if (window.location.pathname === "/workspace") {
    return <WorkspacePage />;
  }
  if (window.location.pathname === "/backup") {
    return <BackupPage />;
  }
  return <LandingPage />;
}

export default App;
