import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  FileText,
  LockKeyhole,
  Plus,
  Search,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { useEffect, useState } from "react";

type SetupStatus = {
  setup_required: boolean;
  ai_available: boolean;
};

const journey = [
  {
    number: "01",
    title: "Add the records",
    body: "Upload PDFs or photos. CareLedger keeps the original files unchanged and checks for duplicates.",
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

function App() {
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
    <div className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="#top" aria-label="CareLedger home">
          CareLedger
        </a>
        <div className="command" role="search">
          <Search aria-hidden="true" size={17} />
          <label className="sr-only" htmlFor="record-search">
            Search records, questions, and visits
          </label>
          <input id="record-search" placeholder="Search when your records are ready" disabled />
          <kbd>⌘ K</kbd>
        </div>
        <button className="quiet-button" type="button" disabled>
          <CircleHelp aria-hidden="true" size={17} />
          Help
        </button>
      </header>

      <main id="top">
        <section className="welcome" aria-labelledby="welcome-title">
          <div className="welcome-copy">
            <p className="context-line">A private place for the family health story</p>
            <h1 id="welcome-title">Know what is happening. Know what to ask next.</h1>
            <p className="lede">
              CareLedger turns a pile of health records into a source-linked timeline, gentle
              explanations, and a clear list for the next doctor visit.
            </p>
            <div className="welcome-actions">
              <a className="primary-button" href={setup?.setup_required ? "/setup" : "/records"}>
                {setup?.setup_required ? "Finish private setup" : "Add health records"}
                <ArrowRight aria-hidden="true" size={18} />
              </a>
              <a className="text-link" href="#how-it-works">
                See how it works
              </a>
            </div>
            <p className="safety-note">
              <LockKeyhole aria-hidden="true" size={16} />
              Your originals and reviewed timeline stay in your own CareLedger installation.
            </p>
          </div>

          <aside className="next-panel" aria-labelledby="next-panel-title">
            <div className="next-panel-heading">
              <span className="status-dot" aria-hidden="true" />
              <p>Start here</p>
            </div>
            <h2 id="next-panel-title">Set up your family workspace</h2>
            <p>
              Create the owner account, then add one record. Nothing becomes a trusted medical
              fact until you review it.
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
              <span>{setup?.ai_available ? "AI key connected" : "Add an API key to enable explanations"}</span>
            </div>
          </aside>
        </section>

        <section className="empty-workbench" aria-labelledby="workbench-title">
          <div className="workbench-intro">
            <p className="section-label">Your care workspace</p>
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
              <button className="rail-item" type="button" disabled>
                <Upload aria-hidden="true" size={18} />
                Records
              </button>
              <button className="rail-item" type="button" disabled>
                <Check aria-hidden="true" size={18} />
                Next steps
              </button>
            </nav>

            <div className="brief" id="summary">
              <div className="brief-header">
                <div>
                  <p className="section-label">Family brief</p>
                  <h3>No records yet</h3>
                </div>
                <button className="outline-button" type="button" disabled>
                  <Plus aria-hidden="true" size={17} />
                  Add record
                </button>
              </div>

              <div className="brief-sections">
                <article>
                  <h4>What we know</h4>
                  <p>Reviewed facts from records and family updates will appear here.</p>
                </article>
                <article>
                  <h4>What this means</h4>
                  <p>Each medical term will have a short explanation and a link to its source.</p>
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
              <p>Choose a note to see its exact source page here.</p>
            </aside>
          </div>
        </section>

        <section className="journey" id="how-it-works" aria-labelledby="journey-title">
          <div className="journey-heading">
            <p className="section-label">How it works</p>
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
        </section>

        <section className="trust-strip" aria-label="Safety principles">
          <p>
            <ShieldCheck aria-hidden="true" size={18} />
            Built for careful families, not for replacing medical care.
          </p>
          <button className="disclosure" type="button" disabled>
            Read the privacy model
            <ChevronDown aria-hidden="true" size={17} />
          </button>
        </section>
      </main>

      <footer className="footer">
        <p><span className="wordmark-small">CareLedger</span> keeps the source close.</p>
        <p>Open source · Self-hosted · Not medical advice</p>
      </footer>
    </div>
  );
}

export default App;
