import notes640 from "../../public/images/notes-640.webp";
import notes1200 from "../../public/images/notes-1200.webp";
import notes1536 from "../../public/images/notes-1536.webp";
import { GitHubLink } from "../GitHubLink";

const SOURCE = "https://github.com/devk03/careledger";

function SourceLink({ children }: { children: React.ReactNode }) {
  return <a href={SOURCE} target="_blank" rel="noopener noreferrer"
    referrerPolicy="no-referrer">{children}</a>;
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="shell">
    <header className="shell-nav">
      <a className="shell-wordmark" href="/" aria-label="adeno home">adeno</a>
      <GitHubLink />
    </header>
    {children}
    <footer className="shell-footer">
      <div><span className="shell-footer-mark">adeno</span>
        <p>Open source, built with care for families.</p></div>
      <nav aria-label="Public pages"><a href="/about">About</a>
        <a href="/privacy">Privacy</a></nav>
    </footer>
  </div>;
}

export function HomePage() {
  return <Frame><main className="shell-document" id="main">
    <h1>Adeno is being built in the open.</h1>
    <p className="shell-lede">Health records arrive in pieces. We’re building
      a place where a family can keep the original files and see a day-by-day
      history without losing the source of each detail.</p>
    <p><strong>This hosted workspace is not open for records yet.</strong> There
      is no account creation, upload, or agent connection here. Please do not
      send personal health information to this preview.</p>
    <figure className="shell-figure">
      <picture>
        <source srcSet={`${notes640} 640w, ${notes1200} 1200w, ${notes1536} 1536w`}
          sizes="(max-width: 45rem) 100vw, 65ch" />
        <img src={notes1200} width="1200" height="800" alt=""
          fetchPriority="high" />
      </picture>
      <figcaption>Illustrative notebook artwork. No real records are shown.</figcaption>
    </figure>
    <p><span className="shell-inline-head">What we’re testing.</span> Family-held
      encryption, individual access, an accurate daily timeline, recovery, and
      a connector that only opens records with a person’s approval. Those
      protections need to work together before we invite real families in.</p>
    <p><span className="shell-inline-head">Follow the work.</span> The code is
      public, including the launch checks that are still open. <SourceLink>Read
      the repository and its progress →</SourceLink></p>
    <p className="shell-disclaimer">Adeno organizes information for personal
      understanding. It does not provide medical advice, diagnosis, or a
      treatment plan.</p>
  </main></Frame>;
}

export function AboutPage() {
  return <Frame><main className="shell-document" id="main">
    <h1>About Adeno.</h1>
    <p className="shell-lede">Adeno is an open-source project for adult
      caregivers who need to understand a parent’s health history without
      replacing the original records or the people providing care.</p>
    <p>The planned workspace groups files by the day they describe, keeps
      upload time separate from care dates, and lets authorized family members
      trace a statement back to its source. An agent connector should make
      that history easier to ask about while keeping access in a person’s
      control.</p>
    <p><strong>Those hosted features are still in development.</strong> This
      public shell cannot accept records or create accounts. <SourceLink>See
      the open-source work →</SourceLink></p>
  </main></Frame>;
}

export function PrivacyPage() {
  return <Frame><main className="shell-document" id="main">
    <h1>Privacy, as it stands.</h1>
    <p className="shell-lede">This public shell does not offer sign-in, record
      upload, or a medical-data API. Do not send personal health information
      here.</p>
    <p>As with any website, the host may process ordinary request metadata
      such as IP address, time, and requested path. Following the GitHub link
      takes you to GitHub under its own privacy terms.</p>
    <p>Our goal for a future hosted workspace is family-controlled encryption
      for records. That system is not deployed or verified for real family
      records yet. We will not call this preview end-to-end encrypted or ready
      for care records while those launch checks remain open.</p>
    <p><SourceLink>Inspect the source and launch gates →</SourceLink></p>
  </main></Frame>;
}
