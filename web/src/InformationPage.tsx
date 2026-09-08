import { ArrowRight, Github } from "lucide-react";
import { ButtonLink } from "./ui";

export function PublicFooter() {
  return <footer className="footer public-footer">
    <p><span className="wordmark-small">Adeno</span> keeps the source close.</p>
    <nav aria-label="About Adeno">
      <a href="/about">About Adeno</a>
      <a href="/privacy">Privacy model</a>
      <span className="open-source-link">Open source
        <a className="github-icon" href="https://github.com/devk03/careledger"
          aria-label="View Adeno source on GitHub (opens in a new tab)"
          title="View source on GitHub" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
          <Github size={21} aria-hidden="true" />
        </a>
      </span>
    </nav>
    <p className="footer-purpose">For personal informational use. Not medical advice.</p>
  </footer>;
}

const examples = [
  { name: "A daughter, a few hours away", story: "Maya works full-time and cannot attend every visit with her dad. Reports arrive as photos between everyday family messages.", need: "She wants one place to put the records, understand unfamiliar words, and prepare questions before their next call." },
  { name: "Two siblings, different responsibilities", story: "Alex accompanies their mother to appointments; Sam helps organize paperwork after work. Each has a different piece of the picture.", need: "They need to distinguish what a clinician said from a family question, and agree on who will follow up." },
  { name: "One caregiver, a lot to remember", story: "Jordan helps a parent manage appointments while also looking after a young family. Some days, a quick unorganized note is all there is time for.", need: "They want to return to that note later, find the relevant record, and bring a short list of questions to the next visit." },
];

export function CaregiverExamples() {
  return <section className="caregiver-examples" id="for-caregivers" aria-labelledby="caregivers-title">
    <p className="section-note">Made with adult caregivers in mind</p>
    <h2 id="caregivers-title">Different families. Familiar moments.</h2>
    <p className="examples-disclaimer">Fictional examples—not testimonials or real patient stories. These describe the needs guiding Adeno, not a promise that every feature is available today.</p>
    <div className="caregiver-stories">{examples.map(example => <article key={example.name}>
      <h3>{example.name}</h3><p>{example.story}</p><p>{example.need}</p>
    </article>)}</div>
    <a className="text-link" href="/about">Why we’re building Adeno <ArrowRight size={17} aria-hidden="true" /></a>
  </section>;
}

export function InformationPage({ page }: { page: "privacy" | "about" }) {
  const privacy = page === "privacy";
  return <div className="app-shell information-page">
    <header className="welcome-topbar">
      <a className="wordmark" href="/" aria-label="Adeno home">Adeno</a>
      <nav aria-label="Information navigation"><a href="/">Home</a><a href={privacy ? "/about" : "/privacy"}>{privacy ? "About Adeno" : "Privacy model"}</a><a href="/login">Sign in</a></nav>
    </header>
    <main className="information-content">
      <p className="section-note">{privacy ? "A plain-language explanation · updated September 7, 2026" : "The purpose behind the project"}</p>
      <h1>{privacy ? "The privacy model" : "A little more clarity for the person helping."}</h1>
      {privacy ? <>
        <p className="lede">Health records deserve more than a reassuring lock icon. Here is what this version does—and what it does not yet do.</p>
        <section><h2>The current server can read your records</h2>
          <p>The community edition stores records and case information on the computer or server running Adeno. Whoever operates that installation can access its storage. This is not end-to-end encrypted record storage.</p>
          <p>A hosted service with complete end-to-end encryption is a goal, not a protection available in this build. Do not upload sensitive records to a demonstration or an installation whose operator you do not trust.</p>
        </section>
        <section><h2>AI is optional, and sends information outside Adeno</h2>
          <p>Record organization works with AI turned off. If AI is configured, the explanation flow asks for confirmation before sending the selected original record to the configured provider. That can include the full record, not just a few lines.</p>
          <p>The provider may be OpenRouter, OpenAI, or an operator-configured compatible service. OpenRouter also routes requests to a model provider. Check the named provider and its data-handling terms before agreeing. Server-configured API keys are not included in the browser application.</p>
          <p>Provider retention and data-use rules vary. A request setting is not a guarantee of zero retention or a compliance certification.</p>
        </section>
        <section><h2>Backups and access still matter</h2>
          <p>Originals are preserved by application workflows. The backup tool can create a password-encrypted export; this does not encrypt the live record store end to end. Protect downloaded files and keep the backup password somewhere safe.</p>
          <p>The installation operator is responsible for access, hosting security, retention, and deletion—including backup copies. This build does not provide a complete self-service account or record-deletion workflow. Ask the operator how removal works before uploading.</p>
        </section>
        <section><h2>What the public pages send</h2>
          <p>The GitHub star counter requests only public repository statistics through Adeno’s server. No health record content is included. Clicking the GitHub link takes you to GitHub, which has its own privacy practices.</p>
          <p>The isolated UI preview uses fictional data and does not save records or call an AI provider. It still requests public GitHub statistics. There is no advertising analytics integration in this build.</p>
        </section>
        <section><h2>What is not a current promise</h2>
          <p>Adeno does not claim HIPAA compliance, complete end-to-end encryption, or that nobody except your family can see stored records. Family-member permissions, managed hosting, and optional external reminders are still being developed.</p>
          <p>This page describes the software, not a complete operator-specific legal privacy notice. A hosted launch needs the operator’s identity, contact and rights-request process, retention schedule, subprocessors, and applicable legal review.</p>
        </section>
      </> : <>
        <p className="lede">Helping a parent can mean becoming the person who keeps the paperwork, remembers the questions, and tries to explain it all to everyone else.</p>
        <section><h2>Less organizing. More understanding.</h2><p>Adeno is an open-source project for adult caregivers. Its purpose is to bring scattered records, personal notes, and open questions into one place—with original sources close by and uncertainty left visible.</p><p>The long-term direction is a hosted service that does not require technical setup, while keeping the application open source. Today’s runnable version is a community preview, not a finished public service.</p></section>
        <section><h2>A helper for understanding—not a clinician</h2><p>Use Adeno for personal information, learning, and organization. It does not provide medical advice, diagnose a condition, recommend treatment, or replace a qualified clinician.</p><p>AI explanations may be incomplete or wrong. Check the original record and discuss medical decisions with the care team. Reviewing a note in Adeno means you have chosen to keep it, not that its medical accuracy has been established.</p><p>Adeno is not monitored for emergencies. Do not wait for an app response when urgent medical help is needed.</p></section>
        <section><h2>What is ready, and what is coming</h2><p>The community build supports an owner account, record uploads, optional AI drafts, human review, and organizing questions and follow-ups. Initial setup requires the installation administrator’s setup link. The isolated UI preview is only for trying the interface with fictional data; changes there are not saved.</p><p>Separate family logins and roles, calendar sync, web research, external reminders, managed billing, and complete end-to-end encrypted record storage are planned work—not features to depend on yet.</p></section>
        <CaregiverExamples />
      </>}
      <ButtonLink variant="secondary" href="/">Back to Adeno <ArrowRight size={17} aria-hidden="true" /></ButtonLink>
    </main>
    <PublicFooter />
  </div>;
}
