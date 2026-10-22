/**
 * ============================================================================
 *  api.ts — the browser's only door to the server
 * ============================================================================
 *
 *  Every screen in the console talks to the API through these helpers. Two
 *  rules hold everywhere:
 *
 *    1. The browser never holds a secret. It asks for redacted previews and
 *       writes credentials in one direction only.
 *    2. A failed request surfaces the SERVER's message, not a generic
 *       "something went wrong". The operator needs to know whether the
 *       request was refused, unauthorised, or genuinely broken.
 * ============================================================================
 */

"use client";

/** An error carrying the server's own explanation. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** The shape every JSON endpoint returns. */
interface Envelope {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

async function request<T>(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(
      "The console could not reach its own server. Check that the Next.js process is still running.",
      0
    );
  }

  const text = await response.text();
  let parsed: Envelope | null = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text) as Envelope;
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed.error === "string" && parsed.error.trim()
        ? parsed.error
        : `The request failed with HTTP ${response.status}.`;
    throw new ApiError(message, response.status);
  }

  return (parsed ?? {}) as T;
}

/** GET a JSON endpoint. */
export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, "GET");
}

/** POST a JSON body. */
export function apiPost<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, "POST", body);
}

/** PATCH a JSON body. */
export function apiPatch<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, "PATCH", body);
}

/** DELETE (with an optional query string already embedded in `path`). */
export function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, "DELETE");
}

/**
 * Download a CSV report.
 *
 * The reports endpoint answers with `text/csv`, so it cannot go through the
 * JSON helper: the browser gets a Blob and saves it.
 */
export async function downloadCsv(kind: string): Promise<void> {
  const response = await fetch(`/api/reports?kind=${encodeURIComponent(kind)}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    let message = `The report could not be generated (HTTP ${response.status}).`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload?.error) message = payload.error;
    } catch {
      // Keep the generic message.
    }
    throw new ApiError(message, response.status);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match ? match[1] : `mineazy-${kind}.csv`;

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
