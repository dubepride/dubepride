/**
 * ============================================================================
 *  /api/employees/import — Employee CSV / Excel Batch Import & Template
 * ============================================================================
 *
 *  GET  ?format=csv|xlsx → Download sample import template
 *  POST                  → Import multiple employee records from JSON or
 *                          multipart/form-data spreadsheet (CSV / XLSX / XLS)
 */

import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { importEmployees } from "@/lib/db";
import {
  generateEmployeeTemplateCsv,
  generateEmployeeTemplateXlsx,
  parseEmployeeBuffer,
  type EmployeeImportItem,
} from "@/lib/employee-import";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET ?format=csv|xlsx
 * Download blank template with sample data for employee bulk import.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  const format = (request.nextUrl.searchParams.get("format") || "csv").toLowerCase();

  if (format === "xlsx") {
    const buffer = generateEmployeeTemplateXlsx();
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="employee_import_template.xlsx"',
        ...NO_STORE,
      },
    });
  }

  const csv = generateEmployeeTemplateCsv();
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="employee_import_template.csv"',
      ...NO_STORE,
    },
  });
}

/**
 * POST
 * Accepts either:
 *  1. JSON: { employees: EmployeeImportItem[], updateExisting?: boolean }
 *  2. multipart/form-data: file=(File), updateExisting=("true"|"false")
 */
export async function POST(request: NextRequest): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  const contentType = request.headers.get("content-type") || "";

  let items: EmployeeImportItem[] = [];
  let updateExisting = true;

  if (contentType.includes("multipart/form-data")) {
    try {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!file || typeof file === "string") {
        return Response.json(
          { ok: false, error: "Please attach a CSV or Excel file under the 'file' field." },
          { status: 400, headers: NO_STORE }
        );
      }

      const fileObj = file as File;
      const arrayBuffer = await fileObj.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const parsed = parseEmployeeBuffer(buffer);
      items = parsed.items;

      const rawUpdate = formData.get("updateExisting");
      if (rawUpdate !== null) {
        updateExisting = String(rawUpdate).toLowerCase() !== "false";
      }
    } catch (err) {
      return Response.json(
        {
          ok: false,
          error: `Could not parse spreadsheet file: ${err instanceof Error ? err.message : String(err)}`,
        },
        { status: 400, headers: NO_STORE }
      );
    }
  } else {
    // JSON payload
    try {
      const body = (await request.json()) as {
        employees?: EmployeeImportItem[];
        updateExisting?: boolean;
      };

      if (!Array.isArray(body.employees)) {
        return Response.json(
          { ok: false, error: "Expected an array of employee items in 'employees'." },
          { status: 400, headers: NO_STORE }
        );
      }

      items = body.employees;
      if (body.updateExisting !== undefined) {
        updateExisting = Boolean(body.updateExisting);
      }
    } catch {
      return Response.json(
        { ok: false, error: "Invalid JSON request body." },
        { status: 400, headers: NO_STORE }
      );
    }
  }

  if (items.length === 0) {
    return Response.json(
      { ok: false, error: "No employee records found to import." },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const result = await importEmployees(items, { updateExisting });
    return Response.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: `Import failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500, headers: NO_STORE }
    );
  }
}
