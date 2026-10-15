import { AppHeader } from "./ui";

export function PrivatePrivacyPage() {
  return <div className="workspace-page">
    <AppHeader context="Private Hermes workspace" />
    <main className="workspace-layout">
      <header className="workspace-heading"><h1>Privacy on this private installation</h1>
        <p>This is the trusted, server-readable Hermes MVP.</p></header>
      <section className="workflow-panel"><h2>Who can read records</h2>
        <p>The server operator can read stored records. HTTPS protects transport; private storage permissions and encrypted off-host backups protect other parts of the workflow. This is not family-controlled end-to-end encryption.</p>
        <p>Public signup and invitations are disabled. Account and source permissions govern access inside the application.</p>
      </section>
      <section className="workflow-panel"><h2>When you connect an assistant</h2>
        <p>You explicitly approve read-only sharing of approved history and permitted sources. Selected text and source images may reach your assistant and its model provider under that provider’s terms.</p>
        <p>Disconnect blocks future calls. It cannot erase conversations, downloads or provider copies already received. Sign out when you finish on a shared device.</p>
      </section>
      <section className="workflow-panel"><h2>Records and review</h2>
        <p>Original uploads are preserved separately from derived images. PNG and JPEG intake is supported; PDF intake remains unavailable.</p>
        <p>Sources are untrusted evidence. Notes and document-day placements remain proposed until explicit review. Approval records your choice to publish; it does not establish medical accuracy.</p>
        <p>Use citations to check the original document and page. Keep evidence, family observations and interpretations separate. adeno does not diagnose, prescribe or assign a stage.</p>
      </section>
      <section className="workflow-panel"><h2>Retention and recovery</h2>
        <p>This MVP has no automatic record-deletion schedule. Records, originals and prior backups can remain until the operator deliberately manages them. Do not assume that disconnecting an assistant deletes stored records or backups.</p>
        <p>Recovery requires the encrypted archive and the off-host backup identity. Keep the identity separate from Hermes. This installation makes no HIPAA-compliance claim.</p>
      </section>
      <a href="/pilot">Return to your workspace</a>
    </main>
  </div>;
}
