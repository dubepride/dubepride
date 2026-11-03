/**
 * ============================================================================
 *  employee-import.ts — Employee data parsing & import engine
 * ============================================================================
 *
 *  Supports importing employee master data from CSV, XLSX, and XLS spreadsheets.
 *  Includes flexible header alias detection so HR / payroll files with
 *  varying column names (e.g., "Employee No.", "Emp ID", "Staff Name",
 *  "Job Title", "Site") map accurately.
 */

import * as XLSX from "xlsx";
import type {
  EmployeeImportItem,
  EmployeeImportRowError,
  EmployeeImportResult,
} from "./types";

export type { EmployeeImportItem, EmployeeImportRowError, EmployeeImportResult };

/** Normalized key aliases for intelligent column matching. */
const ALIASES: Record<keyof EmployeeImportItem | "firstName" | "lastName", string[]> = {
  erpUserId: [
    "empid",
    "employeenumber",
    "employeeno",
    "empno",
    "employeeid",
    "empnumber",
    "erpuserid",
    "erpid",
    "staffid",
    "staffno",
    "staffnumber",
    "idnumber",
    "badgenumber",
    "badgeno",
    "payrollid",
    "payrollno",
    "clockingid",
    "workerid",
    "employeeref",
    "empcode",
    "id",
    "code",
  ],
  fullName: [
    "fullname",
    "name",
    "employeename",
    "staffname",
    "workername",
    "names",
    "employee",
    "worker",
  ],
  firstName: ["firstname", "first", "fname", "givenname"],
  lastName: ["lastname", "last", "lname", "surname", "familyname"],
  department: [
    "department",
    "dept",
    "section",
    "division",
    "team",
    "unit",
    "businessunit",
  ],
  position: [
    "position",
    "jobtitle",
    "job",
    "designation",
    "role",
    "title",
    "occupation",
  ],
  branch: [
    "branch",
    "site",
    "location",
    "branchname",
    "worksite",
    "mine",
    "minesite",
    "plant",
    "assignedbranch",
  ],
  shift: [
    "shift",
    "shiftid",
    "shiftname",
    "workshift",
    "roster",
    "shifttype",
  ],
  status: [
    "status",
    "employmentstatus",
    "state",
    "active",
    "isactive",
  ],
  enrolled: [
    "enrolled",
    "fingerprintenrolled",
    "fingerprint",
    "biometric",
    "biometrics",
    "biometricenrolled",
  ],
  mobilePin: [
    "pin",
    "mobilepin",
    "passcode",
    "password",
    "pinref",
  ],
};

/** Normalizes a string key to lowercase alphanumeric chars only. */
export function normalizeHeader(key: string): string {
  return String(key || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Detects mapping from input column names to canonical EmployeeImportItem fields.
 */
export function detectHeaderMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  const used = new Set<string>();

  const normalizedHeaders = headers.map((h) => ({
    original: h,
    clean: normalizeHeader(h),
  }));

  const fields = Object.keys(ALIASES) as (keyof typeof ALIASES)[];

  for (const field of fields) {
    const aliasList = ALIASES[field];
    // Exact normalized match first
    let match = normalizedHeaders.find(
      (nh) => !used.has(nh.original) && aliasList.includes(nh.clean)
    );

    // Substring match fallback
    if (!match) {
      match = normalizedHeaders.find(
        (nh) =>
          !used.has(nh.original) &&
          aliasList.some((a) => nh.clean.includes(a) || a.includes(nh.clean))
      );
    }

    if (match) {
      mapping[field] = match.original;
      used.add(match.original);
    }
  }

  return mapping;
}

/** Parses raw records into normalized EmployeeImportItem entries. */
export function parseEmployeeRows(
  rows: Record<string, unknown>[],
  headerMapping?: Record<string, string>
): {
  items: EmployeeImportItem[];
  validCount: number;
  invalidCount: number;
  detectedMapping: Record<string, string>;
} {
  if (rows.length === 0) {
    return {
      items: [],
      validCount: 0,
      invalidCount: 0,
      detectedMapping: {},
    };
  }

  // Derive column headers from all rows
  const allHeaders = Array.from(
    new Set(rows.flatMap((r) => Object.keys(r)))
  );

  const mapping = headerMapping || detectHeaderMapping(allHeaders);

  const items: EmployeeImportItem[] = [];
  let validCount = 0;
  let invalidCount = 0;

  for (const row of rows) {
    // Check if the row is completely empty
    const values = Object.values(row).map((v) => String(v ?? "").trim());
    if (values.every((v) => v === "")) {
      continue;
    }

    const getVal = (field: string): string => {
      const colName = mapping[field];
      if (colName && row[colName] !== undefined && row[colName] !== null && String(row[colName]).trim() !== "") {
        return String(row[colName]).trim();
      }
      // Fallback: search row keys directly matching any alias for this field
      const aliases = ALIASES[field as keyof typeof ALIASES] || [];
      for (const [k, v] of Object.entries(row)) {
        if (v !== undefined && v !== null && String(v).trim() !== "") {
          const cleanKey = normalizeHeader(k);
          if (cleanKey === normalizeHeader(field) || aliases.includes(cleanKey)) {
            return String(v).trim();
          }
        }
      }
      return "";
    };

    const rawErpUserId = getVal("erpUserId");
    const erpUserId = rawErpUserId
      ? /^(ERP|EMP)[-_ ]?(.+)$/i.test(rawErpUserId)
        ? `EMP${rawErpUserId.replace(/^(ERP|EMP)[-_ ]?/i, "").trim()}`
        : /^\d+$/.test(rawErpUserId)
        ? `EMP${rawErpUserId}`
        : rawErpUserId
      : "";
    let fullName = getVal("fullName");
    const firstName = getVal("firstName");
    const lastName = getVal("lastName");

    if (!fullName && (firstName || lastName)) {
      fullName = `${firstName} ${lastName}`.trim();
    }

    const department = getVal("department");
    const position = getVal("position");
    const branch = getVal("branch");
    const shift = getVal("shift");
    const rawStatus = getVal("status").toLowerCase();
    const rawEnrolled = getVal("enrolled").toLowerCase();
    const mobilePin = getVal("mobilePin");

    let status = "Active";
    if (rawStatus === "inactive" || rawStatus === "0" || rawStatus === "disabled" || rawStatus === "no") {
      status = "Inactive";
    } else if (rawStatus === "leave" || rawStatus === "on leave") {
      status = "On Leave";
    }

    let enrolled: boolean | undefined = undefined;
    if (rawEnrolled) {
      enrolled =
        rawEnrolled === "1" ||
        rawEnrolled === "true" ||
        rawEnrolled === "yes" ||
        rawEnrolled === "y";
    }

    const item: EmployeeImportItem = {
      erpUserId,
      fullName,
      department,
      position,
      branch,
      shift: shift || null,
      status,
      enrolled,
      mobilePin: mobilePin || undefined,
    };

    if (erpUserId && fullName) {
      validCount++;
    } else {
      invalidCount++;
    }

    items.push(item);
  }

  return {
    items,
    validCount,
    invalidCount,
    detectedMapping: mapping,
  };
}

/** Parses a spreadsheet buffer (CSV, XLSX, XLS) into employee import items. */
export function parseEmployeeBuffer(buffer: Buffer | ArrayBuffer): {
  items: EmployeeImportItem[];
  rawHeaders: string[];
  totalRawRows: number;
  validCount: number;
  invalidCount: number;
  detectedMapping: Record<string, string>;
} {
  const workbook = XLSX.read(buffer, { type: buffer instanceof Buffer ? "buffer" : "array" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    return {
      items: [],
      rawHeaders: [],
      totalRawRows: 0,
      validCount: 0,
      invalidCount: 0,
      detectedMapping: {},
    };
  }

  const sheet = workbook.Sheets[firstSheetName];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  const rawHeaders = Array.from(
    new Set(rawRows.flatMap((r) => Object.keys(r)))
  );

  const parsed = parseEmployeeRows(rawRows);

  return {
    items: parsed.items,
    rawHeaders,
    totalRawRows: rawRows.length,
    validCount: parsed.validCount,
    invalidCount: parsed.invalidCount,
    detectedMapping: parsed.detectedMapping,
  };
}

/** Sample employee rows for user template downloads. */
export const SAMPLE_EMPLOYEE_ROWS: Record<string, string>[] = [
  {
    "Employee Number": "EMP1016",
    "Full Name": "Kagiso Molefe",
    "Department": "Mining Operations",
    "Position": "Drill Rig Operator",
    "Branch": "Main Shaft",
    "Shift": "Morning",
    "Status": "Active",
  },
  {
    "Employee Number": "EMP1017",
    "Full Name": "Thabo Sithole",
    "Department": "Engineering",
    "Position": "Electrical Technician",
    "Branch": "Branch 1",
    "Shift": "Day",
    "Status": "Active",
  },
  {
    "Employee Number": "EMP1018",
    "Full Name": "Nomvula Dlamini",
    "Department": "Safety & Health",
    "Position": "Safety Officer",
    "Branch": "Branch 4",
    "Shift": "Day",
    "Status": "Active",
  },
  {
    "Employee Number": "EMP1019",
    "Full Name": "Bongani Khumalo",
    "Department": "Processing Plant",
    "Position": "Plant Operator",
    "Branch": "Branch 17",
    "Shift": "Night",
    "Status": "Active",
  },
  {
    "Employee Number": "EMP1020",
    "Full Name": "Lerato Mokoena",
    "Department": "Administration",
    "Position": "HR Administrator",
    "Branch": "Main Shaft",
    "Shift": "Day",
    "Status": "Active",
  },
];

/** Generates CSV template string for employee batch import. */
export function generateEmployeeTemplateCsv(): string {
  const worksheet = XLSX.utils.json_to_sheet(SAMPLE_EMPLOYEE_ROWS);
  return XLSX.utils.sheet_to_csv(worksheet);
}

/** Generates Excel (.xlsx) template buffer for employee batch import. */
export function generateEmployeeTemplateXlsx(): Buffer {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(SAMPLE_EMPLOYEE_ROWS);
  XLSX.utils.book_append_sheet(workbook, worksheet, "Employees");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}
