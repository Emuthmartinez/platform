"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Operator = { id: string; email: string; name: string };
type Run = { id: string; status: string; planDigest: string; createdAt: number; createdBy: string; approvedBy: string | null };
type Portfolio = {
  organizations: Array<{ id: string; name: string }>;
  incidents: Array<{ id: string; organizationId: string; name: string }>;
  activeHostnames: Array<{ hostname: string; organizationId: string; incidentId: string }>;
  previewDeployments: Array<{ key: string; hostname: string; lifecycle: string }>;
  recentRuns: Run[];
  operators: Array<{ id: string; email: string; name: string; status: string; lastLoginAt: number | null }>;
  auditEvents: Array<{ id: string; actorOperatorId: string; action: string; targetId: string | null; createdAt: number }>;
};

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

export function ControlPlane() {
  const [operator, setOperator] = useState<Operator | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showPlan, setShowPlan] = useState(false);
  const incidentNames = useMemo(
    () => new Map((portfolio?.incidents ?? []).map((incident) => [incident.id, incident.name])),
    [portfolio?.incidents],
  );

  const authenticate = useCallback(async () => {
    const me = await jsonFetch<{ operator: Operator }>("/api/auth/me");
    setOperator(me.operator);
  }, []);

  const refreshPortfolio = useCallback(async () => {
    setPortfolio(await jsonFetch<Portfolio>("/api/portfolio"));
  }, []);

  useEffect(() => {
    let live = true;
    async function bootstrap() {
      try {
        await authenticate();
        try {
          await refreshPortfolio();
        } catch (cause) {
          if (live) setError(cause instanceof Error ? cause.message : "Portfolio unavailable.");
        }
      } catch {
        if (live) setOperator(null);
      } finally {
        if (live) setLoading(false);
      }
    }
    void bootstrap();
    return () => { live = false; };
  }, [authenticate, refreshPortfolio]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      await jsonFetch("/api/auth/login", { method: "POST", body: JSON.stringify({ email: data.get("email"), password: data.get("password") }) });
      await authenticate();
      try {
        await refreshPortfolio();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Portfolio unavailable.");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Login failed."); }
  }

  async function createPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      await jsonFetch("/api/provisioning-runs", {
        method: "POST",
        body: JSON.stringify({
          organization: { key: data.get("organizationKey"), name: data.get("organizationName") },
          incident: { key: data.get("incidentKey"), name: data.get("incidentName") },
          deployment: { key: data.get("deploymentKey"), hostname: data.get("hostname") },
        }),
      });
      setShowPlan(false);
      await refreshPortfolio();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Plan failed."); }
  }

  async function transitionRun(run: Run, action: "approve" | "apply") {
    setError("");
    try {
      await jsonFetch(`/api/provisioning-runs/${run.id}/${action}`, { method: "POST" });
      await refreshPortfolio();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to ${action} run.`);
    }
  }

  if (loading) return <main className="center"><div className="loader" />Loading control plane…</main>;
  if (!operator) return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark">M</div>
        <p className="eyebrow">MALLANET</p><h1>Control Plane</h1>
        <p className="muted">Global deployment operations. Deployment admins sign in to their own incident panels.</p>
        <form onSubmit={login} className="stack"><label>Email<input name="email" type="email" required autoComplete="username" /></label><label>Password<input name="password" type="password" required autoComplete="current-password" /></label>{error && <p className="error">{error}</p>}<button>Sign in as platform operator</button></form>
      </section>
    </main>
  );

  const runs = portfolio?.recentRuns ?? [];
  return (
    <div className="app-shell">
      <aside><div><div className="brand"><span className="brand-mark small">M</span><span><b>Mallanet</b><small>Control Plane</small></span></div><nav><a className="active" href="#portfolio">Portfolio</a><a href="#provisioning">Provisioning</a><a href="#operators">Operators</a><a href="#audit">Audit log</a></nav></div><div className="operator"><span className="avatar">{(operator.name || operator.email)[0]?.toUpperCase()}</span><span><b>{operator.name || "Platform operator"}</b><small>{operator.email}</small></span></div></aside>
      <main className="content">
        <header><div><p className="eyebrow">GLOBAL OPERATIONS</p><h1>Deployment portfolio</h1><p className="muted">Manage incident environments without entering their operational data.</p></div><button onClick={() => setShowPlan(true)}>Plan deployment</button></header>
        <section className="metrics"><article><span>Organizations</span><strong>{portfolio?.organizations.length ?? 0}</strong></article><article><span>Incidents</span><strong>{portfolio?.incidents.length ?? 0}</strong></article><article><span>Active hostnames</span><strong>{portfolio?.activeHostnames.length ?? 0}</strong></article><article><span>Preview deployments</span><strong>{portfolio?.previewDeployments.length ?? 0}</strong></article></section>
        {error && <p className="error banner">{error}</p>}
        <section className="panel" id="portfolio"><div className="panel-title"><div><h2>Environments</h2><p>Live routing and isolated previews across Mallanet.</p></div><span className={error ? "error" : "healthy"}>{error ? "Attention required" : "Platform ready"}</span></div><div className="table"><div className="tr th"><span>Hostname</span><span>Incident</span><span>Lifecycle</span><span>Authority</span></div>{portfolio?.activeHostnames.map((item) => <div className="tr" key={item.hostname}><span><b>{item.hostname}</b></span><span>{incidentNames.get(item.incidentId) ?? item.incidentId}</span><span><i className="pill active-pill">Active</i></span><span>Deployment admin</span></div>)}{portfolio?.previewDeployments.map((item) => <div className="tr" key={item.key}><span><b>{item.hostname}</b><small>{item.key}</small></span><span>Provisioning ledger</span><span><i className="pill preview-pill">Preview</i></span><span>Platform ops</span></div>)}</div></section>
        <section className="panel" id="provisioning"><div className="panel-title"><div><h2>Provisioning runs</h2><p>Every change is planned, approved by another operator, and resumable.</p></div></div>{runs.length === 0 ? <div className="empty"><b>No provisioning runs yet</b><p>Create a preview plan when the next incident is ready. Nothing will be publicly activated.</p></div> : <div className="runs">{runs.map((run) => <article key={run.id}><span><b>{run.status.replaceAll("_", " ")}</b><small>{run.id}</small></span><code>{run.planDigest.slice(0, 12)}</code>{run.status === "planned" && run.createdBy !== operator.id && <button onClick={() => void transitionRun(run, "approve")}>Approve</button>}{run.status === "approved" && run.approvedBy !== operator.id && <button onClick={() => void transitionRun(run, "apply")}>Apply preview steps</button>}</article>)}</div>}</section>
        <section className="panel" id="operators"><div className="panel-title"><div><h2>Platform operators</h2><p>Separate global identities. Deployment admins are not listed here.</p></div></div><div className="runs">{portfolio?.operators.map((item) => <article key={item.id}><span><b>{item.name || item.email}</b><small>{item.email}</small></span><i className="pill active-pill">{item.status}</i></article>)}</div></section>
        <section className="panel" id="audit"><div className="panel-title"><div><h2>Platform audit</h2><p>The 50 most recent control-plane events.</p></div></div>{portfolio?.auditEvents.length ? <div className="runs">{portfolio.auditEvents.map((event) => <article key={event.id}><span><b>{event.action}</b><small>{event.targetId || "platform"}</small></span><time>{new Date(event.createdAt).toLocaleString()}</time></article>)}</div> : <div className="empty"><b>No platform events yet</b></div>}</section>
      </main>
      {showPlan && <div className="modal-backdrop" onMouseDown={() => setShowPlan(false)}><section className="modal" onMouseDown={(event) => event.stopPropagation()}><div className="panel-title"><div><p className="eyebrow">PREVIEW ONLY</p><h2>Plan a deployment</h2><p>This records desired state. It cannot activate a public deployment.</p></div><button className="icon" onClick={() => setShowPlan(false)} aria-label="Close">×</button></div><form onSubmit={createPlan} className="form-grid"><label>Organization key<input name="organizationKey" placeholder="example-relief" required /></label><label>Organization name<input name="organizationName" placeholder="Example Relief" required /></label><label>Incident key<input name="incidentKey" placeholder="example-quake-2026" required /></label><label>Incident name<input name="incidentName" placeholder="Example Quake 2026" required /></label><label>Deployment key<input name="deploymentKey" placeholder="example-quake-staging" pattern=".*(preview|staging).*" required /></label><label>Preview hostname<input name="hostname" placeholder="preview.example.org" required /></label><div className="modal-actions"><button type="button" className="secondary" onClick={() => setShowPlan(false)}>Cancel</button><button>Create deterministic plan</button></div></form></section></div>}
    </div>
  );
}
