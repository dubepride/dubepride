/**
 * ============================================================================
 *  repo/sites.ts — sites and physical locations
 * ============================================================================
 *
 *  A site is a monitored estate (the office, the branch). A location is a
 *  place inside it (Admin Block, White House, Workshop). Devices point at a
 *  location so the map can group them — without ever inventing a link.
 */

import { getDb, queryAll, queryOne, exec, run } from "../db";
import type { Location, Site } from "../types";

interface SiteRow {
  Site_ID: number;
  Name: string;
  Description: string;
  Created_At: number;
}

interface LocationRow {
  Location_ID: number;
  Site_ID: number | null;
  Name: string;
  Building: string;
  Room: string;
  Notes: string;
  Created_At: number;
}

function toSite(row: SiteRow): Site {
  return { id: row.Site_ID, name: row.Name, description: row.Description, createdAt: row.Created_At };
}

function toLocation(row: LocationRow): Location {
  return {
    id: row.Location_ID,
    siteId: row.Site_ID,
    name: row.Name,
    building: row.Building,
    room: row.Room,
    notes: row.Notes,
    createdAt: row.Created_At,
  };
}

/** Every site. */
export async function listSites(): Promise<Site[]> {
  const rows = await queryAll<SiteRow>(await getDb(), "SELECT * FROM Sites ORDER BY Name COLLATE NOCASE");
  return rows.map(toSite);
}

/** One site by id. */
export async function getSite(id: number): Promise<Site | null> {
  const row = await queryOne<SiteRow>(await getDb(), "SELECT * FROM Sites WHERE Site_ID = ?", id);
  return row ? toSite(row) : null;
}

/** Create a site. */
export async function createSite(name: string, description = ""): Promise<number> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Site name is required.");
  const { lastId } = await run(
    await getDb(),
    "INSERT INTO Sites (Name, Description, Created_At) VALUES (?, ?, ?)",
    trimmed,
    description,
    Date.now()
  );
  return lastId;
}

/** Rename / update a site. */
export async function updateSite(id: number, patch: { name?: string; description?: string }): Promise<void> {
  const db = await getDb();
  const current = await queryOne<SiteRow>(db, "SELECT * FROM Sites WHERE Site_ID = ?", id);
  if (!current) throw new Error("That site no longer exists.");
  await exec(
    db,
    "UPDATE Sites SET Name = ?, Description = ? WHERE Site_ID = ?",
    patch.name?.trim() || current.Name,
    patch.description ?? current.Description,
    id
  );
}

/** Delete a site (locations and devices fall back to "Unassigned"). */
export async function deleteSite(id: number): Promise<void> {
  const db = await getDb();
  await exec(db, "UPDATE Locations SET Site_ID = NULL WHERE Site_ID = ?", id);
  await exec(db, "UPDATE Devices SET Site_ID = NULL WHERE Site_ID = ?", id);
  await exec(db, "DELETE FROM Sites WHERE Site_ID = ?", id);
}

/** Every location. */
export async function listLocations(siteId?: number): Promise<Location[]> {
  const rows = siteId
    ? await queryAll<LocationRow>(
        await getDb(),
        "SELECT * FROM Locations WHERE Site_ID = ? ORDER BY Name COLLATE NOCASE",
        siteId
      )
    : await queryAll<LocationRow>(await getDb(), "SELECT * FROM Locations ORDER BY Name COLLATE NOCASE");
  return rows.map(toLocation);
}

/** One location by id. */
export async function getLocation(id: number): Promise<Location | null> {
  const row = await queryOne<LocationRow>(await getDb(), "SELECT * FROM Locations WHERE Location_ID = ?", id);
  return row ? toLocation(row) : null;
}

/** Create a location. */
export async function createLocation(input: {
  name: string;
  siteId?: number | null;
  building?: string;
  room?: string;
  notes?: string;
}): Promise<number> {
  const trimmed = input.name.trim();
  if (!trimmed) throw new Error("Location name is required.");
  const { lastId } = await run(
    await getDb(),
    "INSERT INTO Locations (Site_ID, Name, Building, Room, Notes, Created_At) VALUES (?, ?, ?, ?, ?, ?)",
    input.siteId ?? null,
    trimmed,
    input.building ?? "",
    input.room ?? "",
    input.notes ?? "",
    Date.now()
  );
  return lastId;
}

/** Update a location. */
export async function updateLocation(
  id: number,
  patch: { name?: string; siteId?: number | null; building?: string; room?: string; notes?: string }
): Promise<void> {
  const db = await getDb();
  const current = await queryOne<LocationRow>(db, "SELECT * FROM Locations WHERE Location_ID = ?", id);
  if (!current) throw new Error("That location no longer exists.");
  await exec(
    db,
    "UPDATE Locations SET Site_ID = ?, Name = ?, Building = ?, Room = ?, Notes = ? WHERE Location_ID = ?",
    patch.siteId === undefined ? current.Site_ID : patch.siteId,
    patch.name?.trim() || current.Name,
    patch.building ?? current.Building,
    patch.room ?? current.Room,
    patch.notes ?? current.Notes,
    id
  );
}

/** Delete a location (devices fall back to "Unassigned"). */
export async function deleteLocation(id: number): Promise<void> {
  const db = await getDb();
  await exec(db, "UPDATE Devices SET Location_ID = NULL WHERE Location_ID = ?", id);
  await exec(db, "DELETE FROM Locations WHERE Location_ID = ?", id);
}

/** Device counts per location (supplementary information for the map). */
export async function deviceCountsByLocation(): Promise<Record<number, number>> {
  const rows = await queryAll<{ Location_ID: number; c: number }>(
    await getDb(),
    "SELECT Location_ID, COUNT(*) AS c FROM Devices WHERE Location_ID IS NOT NULL GROUP BY Location_ID"
  );
  const out: Record<number, number> = {};
  for (const row of rows) out[row.Location_ID] = row.c;
  return out;
}
