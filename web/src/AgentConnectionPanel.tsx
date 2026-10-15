import { useEffect, useRef, useState } from "react";
import { Check, Copy, Plug, ShieldCheck } from "lucide-react";
import { Button, Notice, Textarea } from "./ui";

type Connection = { grantId: string; expiresAt: number; state: "active" | "revoked" | "expired" | "inactive" };
async function agentRequest<T>(path: string, csrfToken: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v2/agent-connections${path}`, { credentials: "same-origin", cache: "no-store",
    ...(signal ? { signal } : {}), ...(body === undefined ? {} : { method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error("We couldn’t confirm the connection request. Check your access below before trying again.");
  return response.status === 204 ? undefined as T : await response.json() as T;
}
function instruction(id: string) {
  return `Connect Codex on this Mac to my private adeno workspace using a local MCP server. Configure the server named adeno_private with this command and argument array.\nCommand: ssh\nArguments: ${JSON.stringify([
    "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "hermes", "sudo", "-n", "docker", "exec", "-i", "--env",
    "ADENO_MCP_TRANSPORT=ssh-stdio", "adeno-private", "node", "server/dist/runPrivateMcp.js", id,
  ])}\nThen call get_connection_profile and list_care_profiles. Confirm the connected account and household, show the available people, and explain whether approved records are available. If Codex needs a new session to load this server, tell me exactly how to continue. This is a read-only, trusted server-readable connection; selected text and source images may reach this assistant and its provider. Do not ask for my password, recovery codes, or model API key. Do not approve or publish records. If this client cannot configure local stdio MCP, explain that limitation plainly.`;
}

export function AgentConnectionPanel({ csrfToken }: { csrfToken: string }) {
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const revision = useRef(0);
  const active = connections.filter(item => item.state === "active" && item.expiresAt * 1000 > now)
    .sort((a, b) => b.expiresAt - a.expiresAt);
  const current = active[0];
  const expiresAt = current?.expiresAt;
  useEffect(() => {
    const controller = new AbortController();
    const startedAt = revision.current;
    async function load() {
      try {
        const capability = await agentRequest<{ available: boolean }>("/capabilities", csrfToken, undefined, controller.signal);
        if (controller.signal.aborted) return;
        setAvailable(capability.available);
        if (capability.available) {
          const result = await agentRequest<{ connections: Connection[] }>("/list", csrfToken, {}, controller.signal);
          if (!controller.signal.aborted && startedAt === revision.current) { setConnections(result.connections); setNow(Date.now()); }
        }
      } catch { if (!controller.signal.aborted) setError("We couldn’t load your assistant access. Use Check access to try again."); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load(); return () => controller.abort();
  }, [csrfToken]);
  useEffect(() => {
    if (!expiresAt) return;
    // One finite expiry update, not background polling.
    const timer = setTimeout(() => { setNow(Date.now()); setCopied(false); }, Math.min(expiresAt * 1000 - Date.now() + 100, 3_600_100));
    return () => clearTimeout(timer);
  }, [expiresAt]);
  async function refresh() {
    const capability = await agentRequest<{ available: boolean }>("/capabilities", csrfToken);
    setAvailable(capability.available);
    if (capability.available) {
      const result = await agentRequest<{ connections: Connection[] }>("/list", csrfToken, {});
      setConnections(result.connections); setNow(Date.now()); setUncertain(false);
    }
  }
  async function act(operation: () => Promise<void>) {
    if (busy) return;
    revision.current++;
    setBusy(true); setError(""); setMessage("");
    try { await operation(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Connection unavailable."); }
    finally { setBusy(false); }
  }
  async function copy() {
    if (!current || current.expiresAt * 1000 <= Date.now()) { setNow(Date.now()); return; }
    setCopyFailed(false); setCopied(false);
    try { await navigator.clipboard.writeText(instruction(current.grantId)); setCopied(true); }
    catch { setCopyFailed(true); }
  }
  return <section id="assistant-setup" className="workflow-panel pilot-assistant" aria-labelledby="assistant-title">
    <div className="pilot-section-label"><Plug size={18} aria-hidden="true" /> ASSISTANT SETUP</div>
    <h2 id="assistant-title">Connect Codex</h2>
    <p className="pilot-section-intro">Ask questions about your approved records, with the original sources close by.</p>
    <p className="pilot-connection-context">Works with Codex on this Mac. Web-only chat is not supported yet.</p>
    {loading ? <p role="status">Checking your assistant access…</p> : <>
      {!available && <Notice tone="info">Assistant setup is unavailable right now. You can still add and review records here.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      {current ? <>
        <div className="pilot-access-state"><ShieldCheck size={18} aria-hidden="true" /><span>Access approved · connection not yet verified</span></div>
        <Button variant="primary" className="pilot-copy-button" disabled={busy} onClick={() => void copy()}>
          {copied ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}
          {copied ? "Copy again" : "Copy setup instruction"}
        </Button>
        {copied && <Notice tone="success">Copied. Paste it into your Codex chat.</Notice>}
        <ol className="pilot-connection-steps">
          <li><strong>Copy the setup instruction.</strong><span>It includes your approved connection ID. No separate API key or MCP token is needed.</span></li>
          <li><strong>Paste it into a Codex chat on this Mac.</strong><span>Send it as a message. Codex will configure the connection or explain the remaining step.</span></li>
          <li><strong>Check Codex’s confirmation.</strong><span>It should confirm your account and list your care profiles. Add and publish a record here before asking about its contents.</span></li>
        </ol>
        <p className="pilot-expiry">Approval expires {new Date(current.expiresAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Signing out also ends this approval.</p>
        {copyFailed && <Notice tone="error">Clipboard access was blocked. Select and copy the instruction below.</Notice>}
        <details className="pilot-connection-details" open={copyFailed || undefined}>
          <summary>Manual copy &amp; technical details</summary>
          <label>Setup instruction<Textarea readOnly value={instruction(current.grantId)} rows={8} onFocus={event => event.currentTarget.select()} /></label>
          <p>This instruction uses MCP over your existing Hermes SSH access. The connection ID alone cannot sign you in.</p>
        </details>
        <Button variant="quiet" disabled={busy} onClick={() => void act(async () => {
          for (const connection of active) await agentRequest(`/${connection.grantId}/disconnect`, csrfToken, {});
          setCopied(false); await refresh(); setMessage("Assistant access disconnected.");
        })}>Disconnect assistant</Button>
      </> : <div className="pilot-consent-block">
        <h3>First, allow read-only access</h3>
        <p>Your assistant and its provider may receive selected record text and source images. Approval lasts up to one hour.</p>
        <label className="pilot-consent"><input type="checkbox" checked={consent} disabled={!available || busy || uncertain}
          onChange={event => setConsent(event.target.checked)} /><span>I allow this assistant to read my approved history and permitted sources.</span></label>
        <Button variant="primary" disabled={!available || !consent || uncertain} loading={busy} onClick={() => void act(async () => {
          setUncertain(true);
          const grant = await agentRequest<{ grantId: string; expiresAt: number }>("", csrfToken, { consent: "approved_history_and_sources_v1" });
          if (!/^[0-9a-f]{32}$/.test(grant.grantId)) throw new Error("The approval result is unconfirmed. Check access before trying again.");
          setConsent(false); setCopied(false); await refresh();
        })}>Create setup instruction</Button>
      </div>}
      <p className="pilot-sharing-note">Disconnect stops future reads. It cannot erase content your assistant has already received.</p>
      <Button variant="quiet" disabled={busy} onClick={() => void act(refresh)}>Check access</Button>
    </>}
  </section>;
}
