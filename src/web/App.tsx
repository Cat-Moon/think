import { useEffect, useState } from "react";
import type { HealthResponse } from "../server/api";

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Think</h1>
      {error && <p>服务未连接：{error}</p>}
      {!error && !health && <p>正在连接服务…</p>}
      {health && (
        <p>
          服务正常 · Node {health.node} · schema v{health.schemaVersion}
        </p>
      )}
    </main>
  );
}
