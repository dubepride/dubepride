/**
 * ============================================================================
 *  Devices page
 * ============================================================================
 *
 *  The inventory grid. Filters by category/state/site/monitored, full-text
 *  search, and links to each device's detail view. Every row shows health,
 *  criticality, monitoring method and freshness — no bare IPs pretending to
 *  be status.
 * ============================================================================
 */

"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { DeviceGlyph, stateColour } from "@/components/DeviceGlyph";
import { useApi } from "@/components/useApi";
import { apiPost } from "@/components/api";
import {
  ErrorNote,
  Labeled,
  Loading,
  Notice,
  PageHeader,
  Panel,
  StateBadge,
  Toolbar,
} from "@/components/ui";
import { humanise, timeAgo } from "@/components/format";
import { DEVICE_CATEGORIES, HEALTH_STATES, type Device } from "@/lib/types";

interface DevicesPayload {
  devices: Device[];
  count: number;
}

const DEFAULT_NEW = {
  name: "",
  hostname: "",
  category: "unknown",
  mgmtIp: "",
  mac: "",
  notes: "",
  monitoringEnabled: true,
  monitorMethod: "icmp",
  criticality: "standard",
};

function DevicesScreen() {
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [category, setCategory] = useState(params.get("category") ?? "");
  const [state, setState] = useState(params.get("state") ?? "");
  const [monitored, setMonitored] = useState(params.get("monitored") === "true");
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(DEFAULT_NEW);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    if (q.trim()) sp.set("q", q.trim());
    if (category) sp.set("category", category);
    if (state) sp.set("state", state);
    if (monitored) sp.set("monitored", "true");
    const s = sp.toString();
    return s ? `/api/devices?${s}` : "/api/devices";
  }, [q, category, state, monitored]);

  const { data, error, loading, refreshing, reload } = useApi<DevicesPayload>(query, {
    pollMs: 30_000,
  });

  const createDevice = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await apiPost("/api/devices", form);
      setForm(DEFAULT_NEW);
      setShowAdd(false);
      reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Devices"
        description="Every device in the inventory. Click a row to see ports, links, evidence and the upstream path."
        actions={
          <>
            <button type="button" className="btn btn--ghost btn--sm" onClick={reload}>
              <Icon name="refresh" size={13} />
              Refresh
            </button>
            <button type="button" className="btn btn--neon btn--sm" onClick={() => setShowAdd((v) => !v)}>
              <Icon name="plus" size={13} />
              Add device
            </button>
          </>
        }
      />

      {showAdd ? (
        <div className="mb-4">
          <Panel title="Add device by hand" subtitle="A manually added device is never overwritten by automatic discovery.">
            <form onSubmit={createDevice} className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <Labeled label="Name *">
                <input
                  className="field"
                  required
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              </Labeled>
              <Labeled label="Hostname">
                <input
                  className="field"
                  value={form.hostname}
                  onChange={(e) => setForm((f) => ({ ...f, hostname: e.target.value }))}
                />
              </Labeled>
              <Labeled label="Category">
                <select
                  className="field"
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                >
                  {DEVICE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {humanise(c)}
                    </option>
                  ))}
                </select>
              </Labeled>
              <Labeled label="Management IP">
                <input
                  className="field"
                  value={form.mgmtIp}
                  onChange={(e) => setForm((f) => ({ ...f, mgmtIp: e.target.value }))}
                />
              </Labeled>
              <Labeled label="MAC">
                <input
                  className="field"
                  value={form.mac}
                  onChange={(e) => setForm((f) => ({ ...f, mac: e.target.value }))}
                />
              </Labeled>
              <Labeled label="Monitor method">
                <select
                  className="field"
                  value={form.monitorMethod}
                  onChange={(e) => setForm((f) => ({ ...f, monitorMethod: e.target.value }))}
                >
                  <option value="icmp">ICMP</option>
                  <option value="tcp">TCP</option>
                  <option value="http">HTTP</option>
                  <option value="snmp">SNMP</option>
                  <option value="none">None</option>
                </select>
              </Labeled>
              <Labeled label="Criticality">
                <select
                  className="field"
                  value={form.criticality}
                  onChange={(e) => setForm((f) => ({ ...f, criticality: e.target.value }))}
                >
                  <option value="critical">Critical</option>
                  <option value="important">Important</option>
                  <option value="standard">Standard</option>
                </select>
              </Labeled>
              <Labeled label="Notes">
                <input
                  className="field"
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                />
              </Labeled>
              <div className="md:col-span-2 xl:col-span-3 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-sm text-muted">
                  <input
                    type="checkbox"
                    checked={form.monitoringEnabled}
                    onChange={(e) => setForm((f) => ({ ...f, monitoringEnabled: e.target.checked }))}
                  />
                  Monitoring enabled
                </label>
                {formError ? <span className="text-xs text-red-400">{formError}</span> : null}
                <button type="submit" className="btn btn--neon btn--sm ml-auto" disabled={saving}>
                  {saving ? <span className="spinner" /> : <Icon name="check" size={13} />}
                  Save device
                </button>
              </div>
            </form>
          </Panel>
        </div>
      ) : null}

      <Toolbar>
        <div className="relative flex-1 min-w-[14rem]">
          <Icon name="search" size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className="field pl-8"
            placeholder="Search by name, hostname, IP, MAC…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select className="field w-auto" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {DEVICE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {humanise(c)}
            </option>
          ))}
        </select>
        <select className="field w-auto" value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">All states</option>
          {HEALTH_STATES.map((s) => (
            <option key={s} value={s}>
              {humanise(s)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 px-2 text-sm text-muted">
          <input type="checkbox" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} />
          Monitored only
        </label>
        {refreshing ? <span className="ml-auto text-xs text-muted">Refreshing…</span> : null}
      </Toolbar>

      <Panel title={`Inventory (${data?.count ?? 0})`}>
        {loading && !data ? (
          <Loading />
        ) : error && !data ? (
          <ErrorNote message={error} onRetry={reload} />
        ) : data && data.devices.length === 0 ? (
          <Notice tone="info">
            No devices match this filter. Add a device by hand or run discovery from the{" "}
            <Link href="/discovery" className="text-neon hover:underline">
              Discovery
            </Link>{" "}
            screen.
          </Notice>
        ) : (
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[980px]">
              <thead className="tbl-head">
                <tr>
                  <th>Name</th>
                  <th>Category</th>
                  <th>State</th>
                  <th>IP / MAC</th>
                  <th>Criticality</th>
                  <th>Monitored</th>
                  <th>Method</th>
                  <th>Last seen</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {data?.devices.map((device) => (
                  <tr key={device.id} className="tbl-row tbl-row--clickable">
                    <td>
                      <Link href={`/devices/${device.id}`} className="flex items-center gap-2.5">
                        <span className="shrink-0 text-violet">
                          <DeviceGlyph
                            category={device.category}
                            size={34}
                            led={stateColour(device.healthState)}
                          />
                        </span>
                        <span className="min-w-0">
                          <span className="block font-semibold text-white">{device.name}</span>
                          <span className="block text-xs text-muted">
                            {device.hostname || "no hostname"}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td>{humanise(device.category)}</td>
                    <td>
                      <StateBadge state={device.healthState} title={device.healthReason} />
                    </td>
                    <td>
                      <div className="font-mono text-xs text-white">{device.mgmtIp || "—"}</div>
                      <div className="font-mono text-xs text-muted">{device.mac || "—"}</div>
                    </td>
                    <td>{humanise(device.criticality)}</td>
                    <td>{device.monitoringEnabled ? "Yes" : "No"}</td>
                    <td>{humanise(device.monitorMethod)}</td>
                    <td className="text-xs text-muted">{timeAgo(device.lastSeenAt)}</td>
                    <td>
                      <div className="text-xs text-white">{humanise(device.discoverySource)}</div>
                      <div className="text-[0.68rem] text-muted">
                        {device.simulated ? "simulated" : "real"}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

export default function DevicesPage() {
  return (
    <Suspense fallback={<Loading label="Loading devices…" />}>
      <DevicesScreen />
    </Suspense>
  );
}
