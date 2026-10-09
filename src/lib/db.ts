export function createTerminal({
  mac,
  ip,
  location,
  branch,
  deviceName,
  status = "Offline",
}: {
  mac: string;
  ip?: string | null;
  location?: string | null;
  branch: string;
  deviceName?: string | null;
  status?: "Online" | "Offline";
}) {
  const db = getDb();
  const loc = (location && location.trim()) || deviceName?.trim() || `Device ${mac.slice(-6)}`;
  const devName = (deviceName && deviceName.trim()) || loc;
  exec(
    db,
    `INSERT INTO Terminals
       (Terminal_MAC, IP_Address, Location_Name, Branch_Name, Status, Last_Ping)
     VALUES (?, ?, ?, ?, ?, ?)`,
    mac.trim(),
    ip?.trim() || "",
    devName,
    branch.trim(),
    status,
    status === "Online" ? Date.now() : null
  );
  const id = queryOne<{ id: number }>(db, "SELECT last_insert_rowid() AS id");
  return Number(id?.id ?? 0);
}

export function updateTerminal(
  terminalId: number,
  patch: {
    mac?: string;
    ip?: string | null;
    location?: string | null;
    branch?: string;
    deviceName?: string | null;
    status?: "Online" | "Offline";
  }
) {
  const db = getDb();
  const current = queryOne<TerminalRow>(db, "SELECT * FROM Terminals WHERE Terminal_ID = ?", terminalId);
  if (!current) return;
  const updates: string[] = [];
  const params: SQLInputValue[] = [];
  if (patch.mac !== undefined) {
    updates.push("Terminal_MAC = ?");
    params.push(patch.mac.trim());
  }
  if (patch.ip !== undefined) {
    updates.push("IP_Address = ?");
    params.push(patch.ip?.trim() || "");
  }
  if (patch.location !== undefined || patch.deviceName !== undefined) {
    const loc = patch.location !== undefined ? patch.location : current.Location_Name;
    const dev = patch.deviceName !== undefined ? patch.deviceName : loc;
    const final = (dev && dev.trim()) || loc;
    updates.push("Location_Name = ?");
    params.push(final.trim());
  }
  if (patch.branch !== undefined) {
    updates.push("Branch_Name = ?");
    params.push(patch.branch.trim());
  }
  if (patch.status !== undefined) {
    updates.push("Status = ?");
    params.push(patch.status);
    updates.push("Last_Ping = ?");
    params.push(patch.status === "Online" ? Date.now() : null);
  }
  if (updates.length === 0) return;
  params.push(terminalId);
  exec(db, `UPDATE Terminals SET ${updates.join(", ")} WHERE Terminal_ID = ?`, ...params);
}

export function deleteTerminal(terminalId: number) {
  exec(getDb(), "DELETE FROM Terminals WHERE Terminal_ID = ?", terminalId);
}