import { useState } from "react";
import { ArrowRight, Check, Plus } from "lucide-react";
import { AppHeader, Badge, Button, ButtonLink, Field, Notice, Select, Textarea } from "./ui";
import { DayTimeline } from "./DayTimeline";

export function DesignSystemPage() {
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  return <>
    <AppHeader context="Design library · fictional examples" />
    <main className="ui-gallery">
      <header>
        <Badge>Local design preview</Badge>
        <h1>One calm, familiar language.</h1>
        <p>The same controls, spacing and feedback everywhere in adeno. Examples below are fictional and stay in this tab. No records are loaded and no AI calls are made.</p>
        <nav className="ui-preview-nav" aria-label="Preview pages">
          <a href="/setup">Setup</a><a href="/login">Sign in</a><a href="/records">Records</a>
          <a href="/workspace">Care dashboard</a><a href="/backup">Backup</a>
        </nav>
      </header>
      <section className="ui-gallery-section" aria-labelledby="foundation-title">
        <h2 id="foundation-title">Warm paper. Clear hierarchy.</h2>
        <p>Geist for reading and controls; Fraunces for the adeno wordmark. Coral points to an action, not a medical conclusion.</p>
        <div className="ui-gallery-grid">{["paper", "raised", "ink", "accent"].map(tone =>
          <figure key={tone}><div className={`ui-swatch ui-swatch-${tone}`} /><figcaption>{tone}</figcaption></figure>
        )}</div>
      </section>
      <section className="ui-gallery-section" aria-labelledby="actions-title">
        <h2 id="actions-title">Actions with a clear next step</h2>
        <div className="ui-gallery-row">
          <Button variant="primary" onClick={() => setSaved(true)}><Plus size={16} aria-hidden="true" />Save sample</Button>
          <Button variant="secondary" onClick={() => setSaved(false)}>Reset example</Button>
          <ButtonLink variant="quiet" href="#fields-title">Try the fields<ArrowRight size={16} aria-hidden="true" /></ButtonLink>
        </div>
        <Notice tone="success">{saved ? "Sample saved in this tab only." : "Try Save sample to see quiet feedback."}</Notice>
        <div className="ui-gallery-grid">
          <div className="ui-state"><small>Default</small><Button variant="primary">Save note</Button></div>
          <div className="ui-state"><small>Hover preview</small><Button variant="primary" className="is-hover">Save note</Button></div>
          <div className="ui-state"><small>Focus preview</small><Button variant="primary" className="is-focus">Save note</Button></div>
          <div className="ui-state"><small>Pressed preview</small><Button variant="primary" className="is-active">Save note</Button></div>
          <div className="ui-state"><small>Disabled: select a record first</small><Button variant="secondary" disabled>Review record</Button></div>
          <div className="ui-state"><small>Loading</small><Button variant="primary" loading>Saving note…</Button></div>
          <div className="ui-state"><small>Error</small><Button variant="secondary" data-state="error">Try saving again</Button></div>
          <div className="ui-state"><small>Success</small><Button variant="secondary" data-state="success"><Check size={16} aria-hidden="true" />Note saved</Button></div>
        </div>
      </section>
      <section className="ui-gallery-section" aria-labelledby="fields-title">
        <h2 id="fields-title">Fields that explain themselves</h2>
        <form noValidate onSubmit={event => { event.preventDefault(); setError(name.trim() ? "" : "Add a fictional nickname to try this example."); }}>
          <Field id="demo-name" label="Fictional nickname" hint="Use a made-up name, not a real person's details." error={error}
            value={name} onChange={event => { setName(event.target.value); if(error) setError(""); }} />
          <label htmlFor="demo-note">Unorganized thoughts (fictional only)</label>
          <Textarea id="demo-note" value={note} onChange={event => setNote(event.target.value)} placeholder="Ask what to bring to the sample appointment." />
          <label htmlFor="demo-priority">When to ask</label>
          <Select id="demo-priority"><option>At the next visit</option><option>When possible</option></Select>
          <Button type="submit" variant="primary">Check example</Button>
        </form>
      </section>
      <section className="ui-gallery-section" aria-labelledby="feedback-title">
        <h2 id="feedback-title">Evidence and feedback stay distinct</h2>
        <div className="ui-gallery-row"><Badge tone="review">AI draft · needs review</Badge><Badge tone="success">Human reviewed</Badge><Badge>Source missing</Badge></div>
        <Notice tone="info">SYNTHETIC TEST RECORD — NOT A REAL PATIENT. Demo appointment: 12 April 2030. Time zone not supplied.</Notice>
        <Notice>Example error: The sample file could not be read. Choose a clearer copy and try again.</Notice>
        <Notice tone="success">Example success: The sample note was saved. This does not confirm a medical finding.</Notice>
      </section>
      <section className="ui-gallery-section" aria-labelledby="timeline-preview-title">
        <h2 id="timeline-preview-title">A day can hold more than one file</h2>
        <p>Fictional layout example only. These files do not exist and nothing here is saved.</p>
        <DayTimeline days={[
          {
            id: "example-day-one",
            day: "2030-04-12",
            files: [
              { id: "example-file-one", name: "fictional-visit.pdf" },
              { id: "example-file-two", name: "fictional-lab.pdf" },
            ],
            notes: [{ id: "example-note", text: "Family wrote down questions after the sample visit.", author: "Example adult" }],
          },
          {
            id: "example-day-two",
            day: "2030-04-09",
            files: [{ id: "example-file-three", name: "fictional-referral.pdf" }],
            notes: [],
          },
        ]} undatedCount={1} />
      </section>
    </main>
  </>;
}
