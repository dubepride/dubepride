"use client";

import { useState } from "react";
import { useApi } from "@/components/useApi";
import { apiPost } from "@/components/api";
import { ErrorNote, Loading, Notice, PageHeader, Panel } from "@/components/ui";
import { formatDateTime } from "@/components/format";
import type { ArpEntry } from "@/lib/net/discovery";

interface DiscoveryPayload {
  targets: { id: number; cidr: string; description: string; enabled: boolean; createdAt: number }[];
  jobs: { id: number; kind: string; status: string; summary: string; startedAt: number; finishedAt: number | null }[];
  arp: ArpEntry[];
  localNetworks: string[];
}

export default function DiscoveryPage() {
  const { data, error, loading, reload } = useApi<DiscoveryPayload>("/api/discovery");
  const [cidr, setCidr] = useState("");
  const [desc, setDesc] = useState("");
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const addTarget = async (): Promise<void> => {
    setAdding(true);
    setMsg(null);
    try {
      await apiPost("/api/discovery/targets", { cidr, description: desc });
      setCidr("");
      setDesc("");
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const runSweep = async (kind: string): Promise<void> => {
    setRunning(true);
    setMsg(null);
    try {
      const res = await apiPost<{ summary?: string }>("/api/discovery", { kind });
      setMsg(res.summary ?? "Discovery job finished.");
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  if (loading && !data) return <Loading label="Loading discovery..." />;
  if (error && !data) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return null;

  return (
    <>
      <PageHeader
        title="Discovery"
        description="Only authorised ranges are scanned. Nothing outside them is touched."
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Authorised scan ranges">
          {data.targets.length === 0 ? (
            <Notice tone="warn">No ranges authorised yet. Add a CIDR before running a sweep.</Notice>
          ) : (
            <ul className="space-y-1.5">
              {data.targets.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1.5">
                  <div>
                    <div className="font-mono text-sm text-white">{t.cidr}</div>
                    <div className="text-xs text-muted">{t.description || "—"}</div>
                  </div>
                  <span className="chip chip--muted">{t.enabled ? "enabled" : "disabled"}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex-1 min-w-[12rem]">
              <span className="label">CIDR</span>
              <input
                className="field"
                placeholder="192.168.1.0/24"
                value={cidr}
                onChange={(e) => setCidr(e.target.value)}
              />
            </label>
            <label className="flex-[2] min-w-[12rem]">
              <span className="label">Description</span>
              <input
                className="field"
                placeholder="Office LAN"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
              />
            </label>
            <button type="button" className="btn btn--neon btn--sm mb-px" disabled={adding || !cidr} onClick={addTarget}>
              Authorise range
            </button>
          </div>
        </Panel>
        <Panel title="Run discovery">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn--ghost btn--sm" disabled={running} onClick={() => runSweep("sweep")}>
              ICMP sweep (authorised ranges)
            </button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={running} onClick={() => runSweep("arp")}>
              Read ARP table
            </button>
          </div>
          {msg ? <p className="mt-2 text-xs text-muted">{msg}</p> : null}
          <div className="mt-3 text-xs text-muted">Local networks detected: {data.localNetworks.join(", ") || "—"}</div>
        </Panel>
      </div>
      <div className="mt-4">
        <Panel title="Job history">
          {data.jobs.length === 0 ? (
            <p className="text-sm text-muted">No discovery jobs run yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {data.jobs.map((j) => (
                <li key={j.id} className="rounded-lg px-1.5 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm text-white">
                      {j.kind} · {j.status}
                    </div>
                    <div className="text-xs text-muted">{formatDateTime(j.startedAt)}</div>
                  </div>
                  <div className="text-xs text-muted">{j.summary || "—"}</div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
