import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeHeader,
  detectHeaderMapping,
  parseEmployeeRows,
  parseEmployeeBuffer,
  generateEmployeeTemplateCsv,
  generateEmployeeTemplateXlsx,
} from "../src/lib/employee-import.ts";

test("normalizeHeader strips spaces, dashes and special characters", () => {
  assert.equal(normalizeHeader("Employee No."), "employeeno");
  assert.equal(normalizeHeader("Emp_ID"), "empid");
  assert.equal(normalizeHeader("Full Name (Official)"), "fullnameofficial");
  assert.equal(normalizeHeader("  Branch / Site  "), "branchsite");
  assert.equal(normalizeHeader(""), "");
});

test("detectHeaderMapping matches common HR and payroll column variations", () => {
  const headers = [
    "Emp No",
    "Employee Name",
    "Dept",
    "Job Title",
    "Site",
    "Work Shift",
    "Employment Status",
  ];

  const mapping = detectHeaderMapping(headers);

  assert.equal(mapping.erpUserId, "Emp No");
  assert.equal(mapping.fullName, "Employee Name");
  assert.equal(mapping.department, "Dept");
  assert.equal(mapping.position, "Job Title");
  assert.equal(mapping.branch, "Site");
  assert.equal(mapping.shift, "Work Shift");
  assert.equal(mapping.status, "Employment Status");
});

test("parseEmployeeRows maps rows and extracts full names correctly", () => {
  const rows = [
    {
      "Employee Number": "EMP_9001",
      "Full Name": "Sipho Sithole",
      "Department": "Mining Operations",
      "Position": "Driller",
      "Branch": "Main Shaft",
      "Shift": "Morning",
      "Status": "Active",
    },
    {
      "Emp ID": "EMP-9002",
      "First Name": "Nandi",
      "Last Name": "Ndlovu",
      "Dept": "Safety",
      "Role": "Inspector",
      "Site": "Branch 1",
      "Shift": "Day",
      "Status": "Active",
    },
  ];

  const result = parseEmployeeRows(rows);

  assert.equal(result.items.length, 2);
  assert.equal(result.validCount, 2);
  assert.equal(result.invalidCount, 0);

  assert.equal(result.items[0].erpUserId, "EMP_9001");
  assert.equal(result.items[0].fullName, "Sipho Sithole");
  assert.equal(result.items[0].department, "Mining Operations");
  assert.equal(result.items[0].position, "Driller");
  assert.equal(result.items[0].branch, "Main Shaft");
  assert.equal(result.items[0].shift, "Morning");
  assert.equal(result.items[0].status, "Active");

  assert.equal(result.items[1].erpUserId, "EMP_9002");
  assert.equal(result.items[1].fullName, "Nandi Ndlovu");
  assert.equal(result.items[1].department, "Safety");
  assert.equal(result.items[1].position, "Inspector");
  assert.equal(result.items[1].branch, "Branch 1");
});

test("parseEmployeeRows flags invalid or missing employee numbers or names", () => {
  const rows = [
    {
      "Emp ID": "",
      "Full Name": "No ID Person",
    },
    {
      "Emp ID": "EMP_9003",
      "Full Name": "",
    },
  ];

  const result = parseEmployeeRows(rows);
  assert.equal(result.items.length, 2);
  assert.equal(result.validCount, 0);
  assert.equal(result.invalidCount, 2);
});

test("generateEmployeeTemplateCsv outputs valid CSV with required headers", () => {
  const csv = generateEmployeeTemplateCsv();
  assert.ok(csv.includes("Employee Number"));
  assert.ok(csv.includes("Full Name"));
  assert.ok(csv.includes("Department"));
  assert.ok(csv.includes("Kagiso Molefe"));
});

test("generateEmployeeTemplateXlsx generates a valid parseable workbook buffer", () => {
  const xlsxBuffer = generateEmployeeTemplateXlsx();
  assert.ok(xlsxBuffer.length > 0);

  const parsed = parseEmployeeBuffer(xlsxBuffer);
  assert.ok(parsed.items.length >= 3);
  assert.equal(parsed.validCount, parsed.items.length);
  assert.equal(parsed.items[0].erpUserId, "EMP_1016");
  assert.equal(parsed.items[0].fullName, "Kagiso Molefe");
});
