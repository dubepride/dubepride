-- ============================================================
--  Demo data removal — generated 2026-11-19T12:25:28.660Z
--  30 punches across: EMP1003, EMP1006, EMP1008, EMP1010, EMP1001, EMP1004
--  Paste into the Turso console (or run with the CLI).
-- ============================================================

-- Preview first:
SELECT Log_ID, Employee_ID, datetime(Timestamp/1000, 'unixepoch') AS utc, Direction
  FROM Attendance_Logs WHERE Log_ID IN (
  16027,
  16028,
  16029,
  16030,
  16031,
  16032,
  16033,
  16034,
  16035,
  16036,
  16037,
  16038,
  16039,
  16040,
  16041,
  16042,
  16043,
  16044,
  16045,
  16046,
  16047,
  16048,
  16049,
  16050,
  16051,
  16052,
  16053,
  16054,
  16055,
  16056
) ORDER BY Timestamp;

-- Then delete:
DELETE FROM Attendance_Logs WHERE Log_ID IN (
  16027,
  16028,
  16029,
  16030,
  16031,
  16032,
  16033,
  16034,
  16035,
  16036,
  16037,
  16038,
  16039,
  16040,
  16041,
  16042,
  16043,
  16044,
  16045,
  16046,
  16047,
  16048,
  16049,
  16050,
  16051,
  16052,
  16053,
  16054,
  16055,
  16056
);

-- ERP sync batches created by the auto-sync are audit history and are left alone.
