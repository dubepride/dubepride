"use client";

import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  parseEmployeeRows,
  type EmployeeImportItem,
  type EmployeeImportResult,
} from "@/lib/employee-import";
import { IconX } from "./icons";

interface EmployeeImportModalProps {
  onClose: () => void;
  onImported: () => void;
}

export default function EmployeeImportModal({
  onClose,
  onImported,
}: EmployeeImportModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [parsedItems, setParsedItems] = useState<EmployeeImportItem[]>([]);
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [detectedMapping, setDetectedMapping] = useState<Record<string, string>>({});
  const [validCount, setValidCount] = useState(0);
  const [invalidCount, setInvalidCount] = useState(0);
  const [updateExisting, setUpdateExisting] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<EmployeeImportResult | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Close on Escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !importing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, importing]);

  function handleFile(file: File) {
    setFileName(file.name);
    setFileSize(file.size);
    setImportError(null);
    setImportResult(null);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        if (!data) return;

        const workbook = XLSX.read(data, {
          type: "array",
          cellDates: true,
        });

        const sheetName = workbook.SheetNames[0];
        if (!sheetName) {
          setImportError("The uploaded workbook has no sheets.");
          return;
        }

        const sheet = workbook.Sheets[sheetName];
        const rawJson = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
          defval: "",
          raw: false,
        });

        if (rawJson.length === 0) {
          setImportError("No rows found in the uploaded file.");
          return;
        }

        const headers = Array.from(new Set(rawJson.flatMap((r) => Object.keys(r))));
        setRawHeaders(headers);

        const parsed = parseEmployeeRows(rawJson);
        setParsedItems(parsed.items);
        setValidCount(parsed.validCount);
        setInvalidCount(parsed.invalidCount);
        setDetectedMapping(parsed.detectedMapping);

        if (parsed.validCount === 0) {
          setImportError(
            "Could not find valid employee records with both Employee ID and Full Name. Please check your column headers."
          );
        }
      } catch (err) {
        setImportError(
          `Failed to parse file: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    };

    reader.onerror = () => {
      setImportError("Failed to read the file from disk.");
    };

    reader.readAsArrayBuffer(file);
  }

  function onFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  async function executeImport() {
    if (parsedItems.length === 0) return;
    setImporting(true);
    setImportError(null);

    try {
      const res = await fetch("/api/employees/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employees: parsedItems,
          updateExisting,
        }),
      });

      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        total?: number;
        created?: number;
        updated?: number;
        skipped?: number;
        errors?: { row: number; erpUserId?: string; name?: string; message: string }[];
      };

      if (!res.ok || !json.ok) {
        throw new Error(json.error || `Import failed with HTTP ${res.status}`);
      }

      setImportResult({
        total: json.total ?? parsedItems.length,
        created: json.created ?? 0,
        updated: json.updated ?? 0,
        skipped: json.skipped ?? 0,
        errors: json.errors ?? [],
      });

      onImported();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Import Employees"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={() => !importing && onClose()}
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-md"
      />

      <div className="glass rise relative z-10 flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0d121d]/95 shadow-2xl">
        <div className="accent-line" aria-hidden="true" />

        {/* Modal Header */}
        <header className="flex items-start justify-between border-b border-white/[0.08] px-6 py-4">
          <div>
            <h3 className="text-base font-bold tracking-[0.16em] text-ink uppercase">
              Import Employees Data
            </h3>
            <p className="mt-1 text-xs text-muted">
              Import multiple employee records at once from CSV or Excel (.xlsx / .xls) spreadsheets.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={importing}
            aria-label="Close"
            className="rounded-lg border border-white/10 bg-white/[0.04] p-2 text-muted transition hover:border-white/25 hover:text-ink disabled:opacity-50"
          >
            <IconX className="h-4 w-4" />
          </button>
        </header>

        {/* Modal Body */}
        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {/* Download Sample Template section */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 text-xs">
            <div className="space-y-0.5">
              <span className="font-semibold text-ink">Need the file format template?</span>
              <p className="text-muted">
                Download a pre-formatted template with sample columns (Employee Number, Full Name, Department, Branch, Shift, Status).
              </p>
            </div>
            <div className="flex items-center gap-2">
              <a
                href="/api/employees/import?format=csv"
                download="employee_import_template.csv"
                className="btn btn--ghost px-3! py-1.5! text-[11px]!"
              >
                CSV Template
              </a>
              <a
                href="/api/employees/import?format=xlsx"
                download="employee_import_template.xlsx"
                className="btn btn--ghost px-3! py-1.5! text-[11px]!"
              >
                Excel (.xlsx) Template
              </a>
            </div>
          </div>

          {/* Upload Dropzone */}
          {!importResult && (
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
                onChange={onFileInputChange}
                className="hidden"
                id="employee-file-input"
              />
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-6 text-center transition ${
                  isDragging
                    ? "border-neon bg-neon/5"
                    : fileName
                      ? "border-white/20 bg-white/[0.03] hover:border-neon/50"
                      : "border-white/10 bg-white/[0.02] hover:border-white/25 hover:bg-white/[0.04]"
                }`}
              >
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-neon/10 text-neon">
                  <svg
                    className="h-6 w-6"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.75}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                    />
                  </svg>
                </div>
                {fileName ? (
                  <div>
                    <p className="text-sm font-semibold text-ink">{fileName}</p>
                    <p className="mt-1 text-xs text-muted">
                      {fileSize ? `${(fileSize / 1024).toFixed(1)} KB` : ""} · Click or drop another file to replace
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm font-semibold text-ink">
                      Click to choose or drag & drop CSV or Excel spreadsheet
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Supports .csv, .xlsx, and .xls files
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Import Result Screen */}
          {importResult && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5">
                <div className="flex items-center gap-3 text-emerald-400">
                  <svg className="h-6 w-6 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  <div>
                    <h4 className="font-bold text-sm text-ink uppercase tracking-wider">Import Completed Successfully</h4>
                    <p className="mt-0.5 text-xs text-emerald-300">
                      Roster has been updated with imported employee records.
                    </p>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-xl border border-white/5 bg-black/20 p-3 text-center">
                    <span className="block text-xl font-bold text-ink">{importResult.total}</span>
                    <span className="text-[10px] uppercase tracking-wider text-muted">Processed</span>
                  </div>
                  <div className="rounded-xl border border-white/5 bg-black/20 p-3 text-center">
                    <span className="block text-xl font-bold text-emerald-400">+{importResult.created}</span>
                    <span className="text-[10px] uppercase tracking-wider text-muted">Created</span>
                  </div>
                  <div className="rounded-xl border border-white/5 bg-black/20 p-3 text-center">
                    <span className="block text-xl font-bold text-cyan-400">{importResult.updated}</span>
                    <span className="text-[10px] uppercase tracking-wider text-muted">Updated</span>
                  </div>
                  <div className="rounded-xl border border-white/5 bg-black/20 p-3 text-center">
                    <span className="block text-xl font-bold text-amber-400">{importResult.skipped}</span>
                    <span className="text-[10px] uppercase tracking-wider text-muted">Skipped</span>
                  </div>
                </div>
              </div>

              {importResult.errors.length > 0 && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                  <h5 className="font-semibold text-xs text-amber-300 uppercase tracking-wider">
                    Warnings / Skipped Rows ({importResult.errors.length})
                  </h5>
                  <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs text-muted">
                    {importResult.errors.map((e, idx) => (
                      <li key={idx} className="flex gap-2">
                        <span className="font-mono text-amber-400">Row {e.row}:</span>
                        <span>{e.message} {e.erpUserId ? `(ID: ${e.erpUserId})` : ""}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Parsed Data Preview & Settings */}
          {parsedItems.length > 0 && !importResult && (
            <div className="space-y-4">
              {/* Stats & Mapping badges */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] pb-3 text-xs">
                <div className="flex items-center gap-3">
                  <span className="chip chip--neon font-mono">
                    {parsedItems.length} ROWS FOUND
                  </span>
                  <span className="chip chip--cyan">
                    {validCount} VALID
                  </span>
                  {invalidCount > 0 && (
                    <span className="chip chip--amber">
                      {invalidCount} INCOMPLETE
                    </span>
                  )}
                </div>

                <label className="flex cursor-pointer items-center gap-2 select-none">
                  <input
                    type="checkbox"
                    checked={updateExisting}
                    onChange={(e) => setUpdateExisting(e.target.checked)}
                    className="accent-neon h-4 w-4 rounded border-white/20 bg-white/5"
                  />
                  <span className="text-xs text-ink">Update existing employees if ID matches</span>
                </label>
              </div>

              {/* Detected Column Mapping */}
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-xs">
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted block mb-1.5">
                  Detected Column Mapping
                </span>
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-muted">
                    Employee ID: <strong className="text-neon">{detectedMapping.erpUserId || "(Auto)"}</strong>
                  </span>
                  <span className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-muted">
                    Full Name: <strong className="text-neon">{detectedMapping.fullName || "(Auto)"}</strong>
                  </span>
                  {detectedMapping.department && (
                    <span className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-muted">
                      Department: <strong className="text-ink">{detectedMapping.department}</strong>
                    </span>
                  )}
                  {detectedMapping.position && (
                    <span className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-muted">
                      Position: <strong className="text-ink">{detectedMapping.position}</strong>
                    </span>
                  )}
                  {detectedMapping.branch && (
                    <span className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-muted">
                      Branch / Site: <strong className="text-ink">{detectedMapping.branch}</strong>
                    </span>
                  )}
                  {detectedMapping.shift && (
                    <span className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-muted">
                      Shift: <strong className="text-ink">{detectedMapping.shift}</strong>
                    </span>
                  )}
                  {detectedMapping.status && (
                    <span className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-muted">
                      Status: <strong className="text-ink">{detectedMapping.status}</strong>
                    </span>
                  )}
                </div>
              </div>

              {/* Preview Table */}
              <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-black/20">
                <div className="max-h-56 overflow-y-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 border-b border-white/[0.08] bg-[#0c121e] text-[10px] font-bold uppercase tracking-wider text-muted">
                      <tr>
                        <th className="px-3 py-2">#</th>
                        <th className="px-3 py-2">Emp ID</th>
                        <th className="px-3 py-2">Full Name</th>
                        <th className="px-3 py-2">Department</th>
                        <th className="px-3 py-2">Position</th>
                        <th className="px-3 py-2">Branch / Site</th>
                        <th className="px-3 py-2">Shift</th>
                        <th className="px-3 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04]">
                      {parsedItems.slice(0, 15).map((row, idx) => {
                        const isValid = Boolean(row.erpUserId && row.fullName);
                        return (
                          <tr
                            key={idx}
                            className={`transition hover:bg-white/[0.02] ${
                              !isValid ? "bg-amber-500/5 text-amber-200" : ""
                            }`}
                          >
                            <td className="px-3 py-2 font-mono text-muted">{idx + 1}</td>
                            <td className="px-3 py-2 font-mono font-medium text-neon">
                              {row.erpUserId || <span className="text-amber-400 italic">Missing</span>}
                            </td>
                            <td className="px-3 py-2 font-medium text-ink">
                              {row.fullName || <span className="text-amber-400 italic">Missing</span>}
                            </td>
                            <td className="px-3 py-2 text-muted">{row.department || "—"}</td>
                            <td className="px-3 py-2 text-muted">{row.position || "—"}</td>
                            <td className="px-3 py-2 text-muted">{row.branch || "—"}</td>
                            <td className="px-3 py-2 text-muted">{String(row.shift || "—")}</td>
                            <td className="px-3 py-2">
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                  row.status === "Active"
                                    ? "bg-emerald-500/20 text-emerald-300"
                                    : "bg-white/10 text-muted"
                                }`}
                              >
                                {row.status || "Active"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {parsedItems.length > 15 && (
                  <div className="border-t border-white/[0.06] bg-white/[0.01] px-3 py-1.5 text-center text-[11px] text-muted">
                    Showing first 15 of {parsedItems.length} records…
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Form / API error message */}
          {importError && (
            <p className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-xs text-danger">
              {importError}
            </p>
          )}
        </div>

        {/* Modal Footer */}
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.08] px-6 py-4">
          <div className="text-xs text-muted">
            {parsedItems.length > 0 && !importResult ? (
              <span>Ready to import <strong>{validCount}</strong> valid employee records</span>
            ) : null}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={importing}
              className="btn btn--ghost text-xs"
            >
              {importResult ? "Close" : "Cancel"}
            </button>

            {!importResult && (
              <button
                type="button"
                onClick={executeImport}
                disabled={importing || validCount === 0}
                className="btn btn--neon text-xs disabled:opacity-50"
              >
                {importing ? (
                  <>
                    <span className="spinner" aria-hidden="true" />
                    <span>Importing {validCount} Employees…</span>
                  </>
                ) : (
                  <span>Confirm & Import ({validCount})</span>
                )}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
