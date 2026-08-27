import { expect, test } from "bun:test";
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
  findToolLocations,
  listDrawers,
  recordDrawerObservation,
} = await import("./db");

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
