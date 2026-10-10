/**
 * BIOBRIDGE Phase 9 - Mock Reports Data
 * Realistic mock data for employee exceptions analysis.
 */

export interface ExceptionTrend {
  date: string;
  arrivedLate: number;
  leftEarly: number;
  missingPunch: number;
  noShow: number;
}

export interface BranchException {
  branchName: string;
  totalExceptions: number;
}

export interface MockExceptionEvent {
  id: string;
  date: string;
  employeeName: string;
  branch: string;
  exceptionType: "Arrived Early" | "Arrived Late" | "Left Early" | "Left Late" | "No Show" | "Missing Punch";
  variance: string;
}

export const mockExceptionTrends: ExceptionTrend[] = [
  { date: "2026-10-09", arrivedLate: 8, leftEarly: 5, missingPunch: 2, noShow: 1 },
  { date: "2026-10-10", arrivedLate: 6, leftEarly: 7, missingPunch: 3, noShow: 0 },
  { date: "2026-10-11", arrivedLate: 12, leftEarly: 4, missingPunch: 1, noShow: 2 },
  { date: "2026-10-12", arrivedLate: 9, leftEarly: 6, missingPunch: 4, noShow: 1 },
  { date: "2026-10-13", arrivedLate: 7, leftEarly: 8, missingPunch: 2, noShow: 0 },
  { date: "2026-10-14", arrivedLate: 11, leftEarly: 5, missingPunch: 5, noShow: 3 },
  { date: "2026-10-15", arrivedLate: 14, leftEarly: 9, missingPunch: 3, noShow: 2 }
];

export const mockBranchExceptions: BranchException[] = [
  { branchName: "Branch 1", totalExceptions: 18 },
  { branchName: "Branch 4", totalExceptions: 25 },
  { branchName: "Branch 9", totalExceptions: 16 },
  { branchName: "Branch 12", totalExceptions: 31 },
  { branchName: "Branch 17", totalExceptions: 22 }
];

export const mockExceptionEvents: MockExceptionEvent[] = [
  { id: "EXC-001", date: "2026-10-15", employeeName: "Marcus Delaney", branch: "Branch 4", exceptionType: "Arrived Late", variance: "+45 mins" },
  { id: "EXC-002", date: "2026-10-15", employeeName: "Fatima Al-Sayed", branch: "Branch 9", exceptionType: "Arrived Early", variance: "-25 mins" },
  { id: "EXC-003", date: "2026-10-15", employeeName: "Thomas Achebe", branch: "Branch 12", exceptionType: "Arrived Late", variance: "+38 mins" },
  { id: "EXC-004", date: "2026-10-14", employeeName: "Sofia Castellanos", branch: "Branch 4", exceptionType: "Left Early", variance: "-32 mins" },
  { id: "EXC-005", date: "2026-10-14", employeeName: "Priya Raghunathan", branch: "Branch 1", exceptionType: "Missing Punch", variance: "—" },
  { id: "EXC-006", date: "2026-10-14", employeeName: "Kwame Mensah", branch: "Branch 17", exceptionType: "No Show", variance: "—" },
  { id: "EXC-007", date: "2026-10-13", employeeName: "Grace Lindqvist", branch: "Branch 12", exceptionType: "Left Early", variance: "-18 mins" },
  { id: "EXC-008", date: "2026-10-13", employeeName: "Elena Petrova", branch: "Branch 4", exceptionType: "Arrived Late", variance: "+27 mins" },
  { id: "EXC-009", date: "2026-10-12", employeeName: "Rafael Moreno", branch: "Branch 17", exceptionType: "Missing Punch", variance: "—" },
  { id: "EXC-010", date: "2026-10-12", employeeName: "Hannah Kim", branch: "Branch 12", exceptionType: "Arrived Late", variance: "+52 mins" },
  { id: "EXC-011", date: "2026-10-11", employeeName: "Daniel Whitfield", branch: "Branch 1", exceptionType: "Left Early", variance: "-21 mins" },
  { id: "EXC-012", date: "2026-10-11", employeeName: "Amara Okafor", branch: "Branch 1", exceptionType: "Arrived Late", variance: "+19 mins" }
];
