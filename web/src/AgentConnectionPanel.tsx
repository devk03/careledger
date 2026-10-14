import { useEffect, useRef, useState } from "react";
import { Button, Notice, Textarea } from "./ui";

type Connection = { grantId: string; expiresAt: number; state: "active" | "revoked" | "expired" | "inactive" };
const stateLabels = { active: "Approval active", revoked: "Disconnected", expired: "Approval expired", inactive: "Sign-in ended" };
async function agentRequest<T>(path: string, csrfToken: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v2/agent-connections${path}`, { credentials: "same-origin", cache: "no-store",
    ...(signal ? { signal } : {}), ...(body === undefined ? {} : { method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error("The connection request could not be confirmed. Refresh your approval list before retrying.");
  return response.status === 204 ? undefined as T : await response.json() as T;
}
function instruction(id: string) {
  return `Connect this assistant to my private adeno workspace with MCP over stdio.\nCommand: ssh\nArguments: ${JSON.stringify([
    "-T", "-o", "BatchMode=yes", "hermes", "sudo", "-n", "docker", "exec", "-i", "--env",
    "ADENO_MCP_TRANSPORT=ssh-stdio", "adeno-private", "node", "server/dist/runPrivateMcp.js", id,
  ])}\nThen call get_connection_profile and show me the account, family and scopes. Do not ask for a password, API key or recovery code. If this client cannot configure a local stdio MCP server, tell me plainly.`;
}

export function AgentConnectionPanel({ csrfToken }: { csrfToken: string }) {
  const [available, setAvailable] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [message, setMessage] = useState("");
  const revision = useRef(0);
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
          if (!controller.signal.aborted && startedAt === revision.current) setConnections(result.connections);
        }
      } catch { /* Unavailable installations keep approval disabled. */ }
    }
    void load(); return () => controller.abort();
  }, [csrfToken]);
  async function refresh() {
    const result = await agentRequest<{ connections: Connection[] }>("/list", csrfToken, {});
    setConnections(result.connections);
    setSelected(current => result.connections.some(connection => connection.grantId === current && connection.state === "active")
      ? current : "");
  }
  async function act(operation: () => Promise<void>) {
    if (busy) return;
    revision.current++;
    setBusy(true); setError(""); setMessage("");
    try { await operation(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Connection unavailable."); }
    finally { setBusy(false); }
  }
  return <section className="workflow-panel"><h2>Connect your assistant</h2>
    <p>This private connection uses your existing SSH access to Hermes and reads approved history and permitted source pages.
      Your assistant and its provider may receive selected record text. adeno remains server-readable.</p>
    <p>Disconnect blocks future tool calls. It cannot erase content already received by your assistant.</p>
    {!available && <Notice>Assistant approval is unavailable on this installation.</Notice>}
    {error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    <label><input type="checkbox" checked={consent} disabled={!available || busy}
      onChange={event => setConsent(event.target.checked)} />I approve read-only sharing of my approved history and permitted source pages with this assistant.</label>
    <Button disabled={!available || !consent} loading={busy} onClick={() => void act(async () => {
      const grant = await agentRequest<{ grantId: string }>("", csrfToken, { consent: "approved_history_and_sources_v1" });
      if (!/^[0-9a-f]{32}$/.test(grant.grantId)) throw new Error("The approval result is unconfirmed. Refresh your approval list.");
      setConsent(false); setSelected(grant.grantId); await refresh();
      setMessage("Approval saved. Connect your assistant and verify its account and scopes.");
    })}>Approve assistant access</Button>
    <Button disabled={!available || busy} onClick={() => void act(refresh)}>Refresh approval list</Button>
    {connections.map(connection => <article key={connection.grantId}>
      <p>{stateLabels[connection.state]} · Expires {new Date(connection.expiresAt * 1000).toLocaleString()}</p>
      {connection.state === "active" && <>
        <Button disabled={busy} onClick={() => setSelected(connection.grantId)}>Show connection instruction</Button>
        <Button disabled={busy} onClick={() => void act(async () => {
          await agentRequest(`/${encodeURIComponent(connection.grantId)}/disconnect`, csrfToken, {});
          if (selected === connection.grantId) setSelected(""); await refresh(); setMessage("Assistant access disconnected.");
        })}>Disconnect assistant</Button>
      </>}
    </article>)}
    {selected && <div><label>Connection instruction<Textarea readOnly value={instruction(selected)} rows={7} /></label>
      <Button disabled={busy} onClick={() => void act(async () => {
        await navigator.clipboard.writeText(instruction(selected)); setMessage("Connection instruction copied.");
      })}>Copy connection instruction</Button></div>}
  </section>;
}
