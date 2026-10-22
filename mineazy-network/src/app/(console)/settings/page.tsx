"use client";

import { useState } from "react";
import { useApi } from "@/components/useApi";
import { apiPatch, apiPost } from "@/components/api";
import { ErrorNote, Labeled, Loading, Notice, PageHeader, Panel } from "@/components/ui";

interface SettingsPayload {
  settings: Record<string, string>;
}

const EDITABLE = [
  { key: "site.name", label: "Site name" },
  { key: "site.description", label: "Site description" },
  { key: "monitor.staleAfterSeconds", label: "Stale after (seconds)", type: "number" },
  { key: "monitor.defaultPollSeconds", label: "Default poll interval (seconds)", type: "number" },
  { key: "monitor.failureThreshold", label: "Failures before OFFLINE", type: "number" },
  { key: "monitor.noTrafficAfterSeconds", label: "No traffic after (seconds)", type: "number" },
  { key: "discovery.rateLimitPerSecond", label: "Discovery rate limit (per second)", type: "number" },
  { key: "collector.mode", label: "Collector mode", type: "select", options: ["real", "simulated", "off"] },
  { key: "retention.trafficDays", label: "Traffic retention (days)", type: "number" },
  { key: "retention.observationDays", label: "Observations retention (days)", type: "number" },
  { key: "retention.eventDays", label: "Events retention (days)", type: "number" },
];

export default function SettingsPage() {
  const { data, error, loading, reload } = useApi<SettingsPayload>("/api/settings");
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [checkpointing, setCheckpointing] = useState(false);
  const [checkpointMsg, setCheckpointMsg] = useState<string | null>(null);

  const values = data?.settings ?? {};

  /**
   * Flush the write-ahead log so that copying `data/mineazy.db` on its own
   * produces a complete snapshot. See docs/backup-and-restore.md.
   */
  const runCheckpoint = async (): Promise<void> => {
    setCheckpointing(true);
    setCheckpointMsg(null);
    try {
      const res = await apiPost<{ detail: string }>("/api/settings", { action: "checkpoint" });
      setCheckpointMsg(res.detail ?? "The checkpoint completed.");
    } catch (e) {
      setCheckpointMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckpointing(false);
    }
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setMsg(null);
    try {
      const changes: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(form)) {
        if (v === "") continue;
        // try number
        if (/^-?\d+$/.test(v)) changes[k] = Number(v);
        else if (v === "true") changes[k] = true;
        else if (v === "false") changes[k] = false;
        else changes[k] = v;
      }
      await apiPatch("/api/settings", { settings: changes });
      setForm({});
      setMsg("Settings saved.");
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) return <Loading label="Loading settings…" />;
  if (error && !data) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return null;

  return (
    <>
      <PageHeader title="Settings" description="Operational configuration. SNMP credentials are managed separately and never exposed here." />
      <Panel title="General">
        <div className="grid gap-3 md:grid-cols-2">
          {EDITABLE.map((f) => (
            <Labeled key={f.key} label={f.label}>
              {f.type === "select" ? (
                <select
                  className="field"
                  value={form[f.key] ?? values[f.key] ?? ""}
                  onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                >
                  {(f.options ?? []).map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input
                  className="field"
                  type={f.type === "number" ? "number" : "text"}
                  value={form[f.key] ?? values[f.key] ?? ""}
                  onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                />
              )}
            </Labeled>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-2">
          <button type="button" className="btn btn--neon btn--sm" onClick={save} disabled={saving || Object.keys(form).length === 0}>
            {saving ? <span className="spinner" /> : null}
            Save changes
          </button>
          {msg ? <span className="text-xs text-muted">{msg}</span> : null}
        </div>
      </Panel>
      <div className="mt-4">
        <Notice tone="info">
          For SNMP credentials, use the API/console&apos;s credentials area or add them via the database/secure process. They are encrypted at rest and never returned to the browser.
        </Notice>
      </div>

      <div className="mt-4">
        <Panel
          title="Maintenance"
          subtitle="Operations a backup script needs. These are audited."
        >
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={runCheckpoint}
              disabled={checkpointing}
            >
              {checkpointing ? <span className="spinner" /> : null}
              Checkpoint the database
            </button>
            {checkpointMsg ? (
              <span className="text-xs text-muted">{checkpointMsg}</span>
            ) : (
              <span className="text-xs text-muted">
                Flushes the write-ahead log so that copying <code>data/mineazy.db</code>{" "}
                on its own produces a complete snapshot.
              </span>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}
