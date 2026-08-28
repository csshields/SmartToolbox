import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// db.ts resolves its database path from process.cwd() at import time and has no
// injection point, so the working directory has to move before the module is
// first loaded. Without this the suite would operate on the real dev database.
const workingDirectory = mkdtempSync(join(tmpdir(), "smarttoolbox-db-"));
process.chdir(workingDirectory);

const {
  addToolToDrawer,
  createDrawer,
  DEFAULT_TOOLBOX_ROWS,
  deleteDrawer,
  deleteTool,
  assignToolToDrawer,
  findToolLocations,
  getDeviceStatus,
  getToolboxRowCount,
  MAX_TOOLBOX_ROWS,
  listDrawers,
  recordDeviceContact,
  recordDrawerObservation,
  recordDrawerObservations,
  pruneRequestLogs,
  recordRequestLog,
  saveToolboxRowCount,
  ToolNameConflictError,
} = await import("./db");

// A second connection to the same file, for asserting on columns the module's
// own API deliberately hides - superseded observations are excluded from every
// query it exposes, which is the whole point of them.
const rawDatabase = new Database(join(workingDirectory, "data", "smarttoolbox.sqlite"));

let uniqueSuffix = 0;

function makeDrawer(rowNumber: number) {
  uniqueSuffix++;
  // Matrix rows are bounded by the toolbox row count now, and drawers are
  // allowed to share one, so fold rather than demanding every test pick a
  // distinct in-range number.
  const foldedRow = ((rowNumber - 1) % DEFAULT_TOOLBOX_ROWS) + 1;
  return createDrawer(`Drawer ${uniqueSuffix}`, { label: `L${uniqueSuffix}`, rowNumber: foldedRow });
}

test("deleteTool removes the tool's observations, not just the tool row", () => {
  const drawer = makeDrawer(4);
  const tool = addToolToDrawer(drawer.id, { name: "Ghost Hammer", quantity: 2 });
  recordDrawerObservation({
    drawerId: drawer.id,
    toolName: "Ghost Hammer",
    quantity: 2,
    confidence: 95,
    modelVersion: "test",
  });

  expect(findToolLocations("Ghost Hammer")).not.toBeNull();

  expect(deleteTool(drawer.id, tool.id)).toBe(true);

  // The regression this guards: selectCanonicalToolName UNIONs
  // drawer_observations, so an orphaned observation kept the tool findable at
  // full confidence while the dashboard showed the drawer as empty.
  expect(findToolLocations("Ghost Hammer")).toBeNull();
});

test("deleteTool leaves an identically named tool in another drawer alone", () => {
  const keep = makeDrawer(2);
  const remove = makeDrawer(3);
  addToolToDrawer(keep.id, { name: "Shared Wrench", quantity: 1 });
  const doomed = addToolToDrawer(remove.id, { name: "Shared Wrench", quantity: 1 });

  recordDrawerObservation({ drawerId: keep.id, toolName: "Shared Wrench", confidence: 80 });
  recordDrawerObservation({ drawerId: remove.id, toolName: "Shared Wrench", confidence: 90 });

  expect(deleteTool(remove.id, doomed.id)).toBe(true);

  const found = findToolLocations("Shared Wrench");
  expect(found).not.toBeNull();
  expect(found!.drawers.map((entry) => entry.drawerId)).toEqual([keep.id]);
});

test("deleteTool refuses a tool id that belongs to a different drawer", () => {
  const owner = makeDrawer(5);
  const other = makeDrawer(6);
  const tool = addToolToDrawer(owner.id, { name: "Misrouted Pliers", quantity: 1 });

  expect(deleteTool(other.id, tool.id)).toBe(false);
  expect(findToolLocations("Misrouted Pliers")).not.toBeNull();
});

test("deleteTool reports false for an id that does not exist", () => {
  const drawer = makeDrawer(2);
  expect(deleteTool(drawer.id, 999999)).toBe(false);
});

test("deleteDrawer cascades its tools and their observations", () => {
  const drawer = makeDrawer(3);
  addToolToDrawer(drawer.id, { name: "Doomed Chisel", quantity: 1 });
  recordDrawerObservation({ drawerId: drawer.id, toolName: "Doomed Chisel", confidence: 70 });

  expect(deleteDrawer(drawer.id)).toBe(true);
  expect(findToolLocations("Doomed Chisel")).toBeNull();
  expect(listDrawers().some((entry) => entry.id === drawer.id)).toBe(false);
});

test("deleteDrawer reports false for an id that does not exist", () => {
  expect(deleteDrawer(999999)).toBe(false);
});

test("recordDeviceContact counts only device/status as a boot", () => {
  recordDeviceContact({ endpoint: "device/status", firmwareVersion: "0.11.0" });
  recordDeviceContact({ endpoint: "tools/lookup" });
  recordDeviceContact({ endpoint: "tools/lookup" });

  const device = getDeviceStatus();

  expect(device?.bootCount).toBe(1);
  expect(device?.lastEndpoint).toBe("tools/lookup");
});

// tools/lookup and vision/observe send no firmwareVersion. If their empty
// string were written through, using the toolbox would erase the version the
// device reported at boot and the dashboard would show it as never reported.
test("recordDeviceContact keeps the last reported firmware version", () => {
  recordDeviceContact({ endpoint: "device/status", firmwareVersion: "0.11.0" });
  recordDeviceContact({ endpoint: "tools/lookup" });

  expect(getDeviceStatus()?.firmwareVersion).toBe("0.11.0");
});

test("getDeviceStatus returns null before the device has ever been seen", async () => {
  // A second database, because the tests above have already written to the
  // module-scope one and the empty case cannot be reached from there.
  const emptyDirectory = mkdtempSync(join(tmpdir(), "smarttoolbox-db-empty-"));
  const previous = process.cwd();
  process.chdir(emptyDirectory);

  try {
    const fresh = await import(`./db?empty=${Date.now()}`);
    expect(fresh.getDeviceStatus()).toBeNull();
  } finally {
    process.chdir(previous);
  }
});

// The bug this guards: selectToolLocations admits a drawer when either a tool
// row or a live observation points at it. Moving only the tool row left the old
// drawer reported as a current location - and at the camera's confidence, while
// the drawer the tool actually moved to had none.
test("moving an observed tool stops its old drawer being reported", () => {
  const source = makeDrawer(11);
  const target = makeDrawer(12);
  const tool = addToolToDrawer(source.id, { name: "Pliers", quantity: 1 });
  recordDrawerObservation({ drawerId: source.id, toolName: "Pliers", confidence: 90 });

  expect(findToolLocations("Pliers")?.drawers.map((d) => d.drawerId)).toEqual([source.id]);

  assignToolToDrawer(target.id, { toolId: tool.id });

  expect(findToolLocations("Pliers")?.drawers.map((d) => d.drawerId)).toEqual([target.id]);
  expect(findToolLocations("Pliers")?.rows.map((r) => r.rowNumber)).toEqual([target.rowNumber!]);
});

test("a superseded observation is kept as history, not deleted", () => {
  const source = makeDrawer(13);
  const target = makeDrawer(14);
  const tool = addToolToDrawer(source.id, { name: "Rasp", quantity: 1 });
  recordDrawerObservation({ drawerId: source.id, toolName: "Rasp", confidence: 80 });

  assignToolToDrawer(target.id, { toolId: tool.id });

  const kept = rawDatabase
    .query("SELECT superseded_at AS supersededAt FROM drawer_observations WHERE drawer_id = ?1")
    .all(source.id) as Array<{ supersededAt: string | null }>;

  expect(kept.length).toBe(1);
  expect(kept[0]?.supersededAt).not.toBeNull();
});

// The old code took the lowest id of a case-insensitive name match, so asking
// for "hammer" could move a different drawer's "Hammer".
test("assignment moves the tool with the given id, not a same-named one", () => {
  const older = makeDrawer(15);
  const newer = makeDrawer(16);
  const target = makeDrawer(17);
  const decoy = addToolToDrawer(older.id, { name: "Hammer", quantity: 1 });
  const wanted = addToolToDrawer(newer.id, { name: "hammer", quantity: 1 });

  const moved = assignToolToDrawer(target.id, { toolId: wanted.id });

  expect(moved.id).toBe(wanted.id);
  expect(moved.drawerId).toBe(target.id);
  expect((listDrawers().find((d) => d.id === older.id))?.tools[0]?.id).toBe(decoy.id);
});

// The old read-back was by (drawer, name) with no COLLATE NOCASE, so a
// case-variant move returned null and the caller reported a failure for a write
// that had already committed.
test("assignment returns the moved tool rather than null", () => {
  const source = makeDrawer(18);
  const target = makeDrawer(19);
  const tool = addToolToDrawer(source.id, { name: "Awl", quantity: 2, notes: "keep" });

  const moved = assignToolToDrawer(target.id, { toolId: tool.id });

  expect(moved).not.toBeNull();
  expect(moved.id).toBe(tool.id);
  expect(moved.quantity).toBe(2);
  expect(moved.notes).toBe("keep");
});

test("a name already in the target drawer is a conflict, not a silent merge", () => {
  const source = makeDrawer(20);
  const target = makeDrawer(21);
  const tool = addToolToDrawer(source.id, { name: "Chisel", quantity: 1 });
  addToolToDrawer(target.id, { name: "chisel", quantity: 1 });

  expect(() => assignToolToDrawer(target.id, { toolId: tool.id })).toThrow(ToolNameConflictError);
  // The failed move must not have superseded the source drawer's observations.
  expect(listDrawers().find((d) => d.id === source.id)?.tools[0]?.id).toBe(tool.id);
});

// Case-insensitive identity: "Punch" and "punch" are one tool. Adding the
// variant updates the existing row and keeps the first capitalisation as the
// display form, rather than creating a second row every read would conflate.
test("a case variant updates the existing tool rather than adding a second", () => {
  const drawer = makeDrawer(22);
  const first = addToolToDrawer(drawer.id, { name: "Punch", quantity: 1 });
  const second = addToolToDrawer(drawer.id, { name: "punch", quantity: 4 });

  expect(second.id).toBe(first.id);
  expect(second.name).toBe("Punch");
  expect(second.quantity).toBe(4);
  expect(listDrawers().find((d) => d.id === drawer.id)?.tools.length).toBe(1);
});

test("case variants of a name resolve to the same tool on lookup", () => {
  const drawer = makeDrawer(23);
  addToolToDrawer(drawer.id, { name: "Mallet", quantity: 1 });

  for (const spelling of ["Mallet", "mallet", "MALLET"]) {
    expect(findToolLocations(spelling)?.primaryLocation?.drawerId).toBe(drawer.id);
  }
});

test("assignment rejects unknown tool and drawer ids", () => {
  const drawer = makeDrawer(24);
  const tool = addToolToDrawer(drawer.id, { name: "Scriber", quantity: 1 });

  expect(() => assignToolToDrawer(drawer.id, { toolId: 999_999 })).toThrow("Tool not found.");
  expect(() => assignToolToDrawer(999_999, { toolId: tool.id })).toThrow("Drawer not found.");
  expect(() => assignToolToDrawer(drawer.id, { toolId: 0 })).toThrow("Tool id is required.");
});

// The bug this guards: the firmware read rowNumber from rows[0] and label from
// drawers[0]. Those arrays are ordered independently - drawers comes back
// ordered by row_number ASC, and SQLite sorts NULLs first, while rows skips
// null row numbers entirely. A tool in an unnumbered drawer and a numbered one
// therefore paired the numbered drawer's row with the unnumbered one's label.
test("primaryLocation pairs a row with its own drawer's label", () => {
  const unnumbered = createDrawer(`Unnumbered ${++uniqueSuffix}`, { label: `U${uniqueSuffix}` });
  const numbered = makeDrawer(5);
  addToolToDrawer(unnumbered.id, { name: "Bradawl", quantity: 1 });
  addToolToDrawer(numbered.id, { name: "Bradawl", quantity: 1 });

  const lookup = findToolLocations("Bradawl")!;

  // The old pairing, reconstructed: it would have shown this row beside this label.
  expect(lookup.drawers[0]?.rowNumber).toBeNull();
  expect(lookup.rows[0]?.rowNumber).toBe(numbered.rowNumber!);

  // The primary is one object, so its row and label always agree.
  expect(lookup.primaryLocation?.drawerId).toBe(numbered.id);
  expect(lookup.primaryLocation?.rowNumber).toBe(numbered.rowNumber!);
  expect(lookup.primaryLocation?.label).toBe(numbered.label);
  expect(lookup.hasMultipleLocations).toBe(true);
});

test("primaryLocation prefers the drawer the camera is most confident about", () => {
  const quiet = makeDrawer(6);
  const confident = makeDrawer(7);
  addToolToDrawer(quiet.id, { name: "Bradawl2", quantity: 1 });
  addToolToDrawer(confident.id, { name: "Bradawl2", quantity: 1 });
  recordDrawerObservation({ drawerId: quiet.id, toolName: "Bradawl2", confidence: 40 });
  recordDrawerObservation({ drawerId: confident.id, toolName: "Bradawl2", confidence: 95 });

  const lookup = findToolLocations("Bradawl2")!;

  expect(lookup.primaryLocation?.drawerId).toBe(confident.id);
  expect(lookup.primaryLocation?.confidence).toBe(95);
});

test("a single location is the primary and is not flagged ambiguous", () => {
  const only = makeDrawer(8);
  addToolToDrawer(only.id, { name: "Bradawl3", quantity: 1 });

  const lookup = findToolLocations("Bradawl3")!;

  expect(lookup.primaryLocation?.drawerId).toBe(only.id);
  expect(lookup.hasMultipleLocations).toBe(false);
});

// A batch whose third detection was invalid used to leave the first two
// committed and still answer 400, so a retrying client doubled the rows that
// had already landed.
test("an invalid detection rolls back the whole batch", () => {
  const drawer = makeDrawer(31);

  expect(() => recordDrawerObservations([
    { drawerId: drawer.id, toolName: "Good One", confidence: 90 },
    { drawerId: drawer.id, toolName: "Good Two", confidence: 80 },
    { drawerId: drawer.id, toolName: "Bad", confidence: 500 },
  ])).toThrow("Observation confidence must be between 0 and 100.");

  const written = rawDatabase
    .query("SELECT COUNT(*) AS n FROM drawer_observations WHERE drawer_id = ?1")
    .get(drawer.id) as { n: number };

  expect(written.n).toBe(0);
});

test("an unknown drawer in a batch writes nothing", () => {
  const drawer = makeDrawer(32);

  expect(() => recordDrawerObservations([
    { drawerId: drawer.id, toolName: "Fine", confidence: 50 },
    { drawerId: 999_999, toolName: "Nowhere", confidence: 50 },
  ])).toThrow("Drawer not found.");

  const written = rawDatabase
    .query("SELECT COUNT(*) AS n FROM drawer_observations WHERE drawer_id = ?1")
    .get(drawer.id) as { n: number };

  expect(written.n).toBe(0);
});

test("a valid batch is written whole", () => {
  const drawer = makeDrawer(33);

  expect(recordDrawerObservations([
    { drawerId: drawer.id, toolName: "Alpha", confidence: 90 },
    { drawerId: drawer.id, toolName: "Beta", confidence: 80 },
  ])).toBe(2);

  const written = rawDatabase
    .query("SELECT COUNT(*) AS n FROM drawer_observations WHERE drawer_id = ?1")
    .get(drawer.id) as { n: number };

  expect(written.n).toBe(2);
});

test("pruneRequestLogs drops entries past the retention window and keeps the rest", () => {
  recordRequestLog({ method: "GET", path: "/api/fresh", statusCode: 200, result: "recent" });

  rawDatabase
    .query("INSERT INTO request_logs (method, path, status_code, result, created_at) VALUES (?1, ?2, ?3, ?4, datetime('now', '-31 days'))")
    .run("GET", "/api/ancient", 200, "old");

  const before = rawDatabase.query("SELECT COUNT(*) AS n FROM request_logs WHERE path = '/api/ancient'").get() as { n: number };
  expect(before.n).toBe(1);

  pruneRequestLogs();

  const ancient = rawDatabase.query("SELECT COUNT(*) AS n FROM request_logs WHERE path = '/api/ancient'").get() as { n: number };
  const fresh = rawDatabase.query("SELECT COUNT(*) AS n FROM request_logs WHERE path = '/api/fresh'").get() as { n: number };

  expect(ancient.n).toBe(0);
  expect(fresh.n).toBe(1);
});

test("a drawer cannot claim a row the panel has no indicator for", () => {
  const rowCount = getToolboxRowCount();

  expect(() => createDrawer(`TooHigh ${++uniqueSuffix}`, { rowNumber: rowCount + 1 }))
    .toThrow(`Matrix row must be a whole number between 1 and ${rowCount}.`);
  expect(() => createDrawer(`TooLow ${++uniqueSuffix}`, { rowNumber: 0 }))
    .toThrow(`Matrix row must be a whole number between 1 and ${rowCount}.`);

  // No row at all stays legal - the drawer is simply not indicatable.
  expect(createDrawer(`NoRow ${++uniqueSuffix}`).rowNumber).toBeNull();
});

// The bound follows the setting rather than a constant, so a bigger toolbox
// just works once its row count is recorded.
test("raising the toolbox row count admits rows that were rejected before", () => {
  const drawerName = `Seven ${++uniqueSuffix}`;

  expect(() => createDrawer(drawerName, { rowNumber: 7 })).toThrow();

  saveToolboxRowCount(7);
  const seventh = createDrawer(drawerName, { rowNumber: 7 });
  expect(seventh.rowNumber).toBe(7);

  // The drawer has to go before the count can come back down - which is the
  // strand guard, exercised here as cleanup.
  expect(() => saveToolboxRowCount(DEFAULT_TOOLBOX_ROWS)).toThrow(drawerName);
  deleteDrawer(seventh.id);
  expect(saveToolboxRowCount(DEFAULT_TOOLBOX_ROWS)).toBe(DEFAULT_TOOLBOX_ROWS);
});

test("the row count is capped by the panel and refuses to strand a drawer", () => {
  expect(() => saveToolboxRowCount(MAX_TOOLBOX_ROWS + 1)).toThrow(/between 1 and/);
  expect(() => saveToolboxRowCount(2.5)).toThrow(/whole number/);

  const drawer = createDrawer(`Stranded ${++uniqueSuffix}`, { rowNumber: DEFAULT_TOOLBOX_ROWS });

  expect(() => saveToolboxRowCount(1)).toThrow(drawer.name);
  // A refused change must leave the setting untouched, not half-applied.
  expect(getToolboxRowCount()).toBe(DEFAULT_TOOLBOX_ROWS);
  deleteDrawer(drawer.id);
});
