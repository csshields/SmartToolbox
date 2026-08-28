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
  deleteDrawer,
  deleteTool,
  assignToolToDrawer,
  findToolLocations,
  getDeviceStatus,
  listDrawers,
  recordDeviceContact,
  recordDrawerObservation,
  ToolNameConflictError,
} = await import("./db");

// A second connection to the same file, for asserting on columns the module's
// own API deliberately hides - superseded observations are excluded from every
// query it exposes, which is the whole point of them.
const rawDatabase = new Database(join(workingDirectory, "data", "smarttoolbox.sqlite"));

let uniqueSuffix = 0;

function makeDrawer(rowNumber: number) {
  uniqueSuffix++;
  return createDrawer(`Drawer ${uniqueSuffix}`, { label: `L${uniqueSuffix}`, rowNumber });
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
  expect(findToolLocations("Pliers")?.rows.map((r) => r.rowNumber)).toEqual([12]);
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

// A case variant left behind means the camera's sighting there is still about a
// real tool, so that drawer keeps its observation.
test("the source drawer keeps its observation when a same-named tool remains", () => {
  const source = makeDrawer(22);
  const target = makeDrawer(23);
  const moving = addToolToDrawer(source.id, { name: "Punch", quantity: 1 });
  addToolToDrawer(source.id, { name: "punch", quantity: 1 });
  recordDrawerObservation({ drawerId: source.id, toolName: "Punch", confidence: 70 });

  assignToolToDrawer(target.id, { toolId: moving.id });

  expect(findToolLocations("punch")?.drawers.map((d) => d.drawerId).sort()).toEqual([source.id, target.id].sort());
});

test("assignment rejects unknown tool and drawer ids", () => {
  const drawer = makeDrawer(24);
  const tool = addToolToDrawer(drawer.id, { name: "Scriber", quantity: 1 });

  expect(() => assignToolToDrawer(drawer.id, { toolId: 999_999 })).toThrow("Tool not found.");
  expect(() => assignToolToDrawer(999_999, { toolId: tool.id })).toThrow("Drawer not found.");
  expect(() => assignToolToDrawer(drawer.id, { toolId: 0 })).toThrow("Tool id is required.");
});
