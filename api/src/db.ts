import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type ToolRecord = {
  id: number;
  drawerId: number;
  name: string;
  quantity: number;
  notes: string;
  createdAt: string;
};

export type DrawerRecord = {
  id: number;
  name: string;
  createdAt: string;
  toolCount: number;
  tools: ToolRecord[];
};

export type RequestLogRecord = {
  id: number;
  method: string;
  path: string;
  tool: string;
  drawerNumber: number | null;
  statusCode: number;
  result: string;
  details: string;
  createdAt: string;
};

const dataDirectory = join(process.cwd(), "data");
mkdirSync(dataDirectory, { recursive: true });

const database = new Database(join(dataDirectory, "smarttoolbox.sqlite"), { create: true });

database.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS drawers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drawer_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(drawer_id) REFERENCES drawers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    tool TEXT NOT NULL DEFAULT '',
    drawer_number INTEGER,
    status_code INTEGER NOT NULL,
    result TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_drawer_name ON tools(drawer_id, name);
  CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at DESC);
`);

const selectDrawers = database.query(`
  SELECT id, name, created_at AS createdAt
  FROM drawers
  ORDER BY name COLLATE NOCASE ASC
`);

const selectTools = database.query(`
  SELECT id, drawer_id AS drawerId, name, quantity, notes, created_at AS createdAt
  FROM tools
  ORDER BY name COLLATE NOCASE ASC
`);

const selectDrawerById = database.query(`
  SELECT id, name, created_at AS createdAt
  FROM drawers
  WHERE id = ?1
`);

const insertDrawer = database.query(`
  INSERT INTO drawers (name)
  VALUES (?1)
`);

const upsertTool = database.query(`
  INSERT INTO tools (drawer_id, name, quantity, notes)
  VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT(drawer_id, name)
  DO UPDATE SET
    quantity = excluded.quantity,
    notes = excluded.notes
`);

const selectToolByDrawerAndName = database.query(`
  SELECT id, drawer_id AS drawerId, name, quantity, notes, created_at AS createdAt
  FROM tools
  WHERE drawer_id = ?1 AND name = ?2
`);

const selectToolByName = database.query(`
  SELECT id, drawer_id AS drawerId, name, quantity, notes, created_at AS createdAt
  FROM tools
  WHERE name = ?1 COLLATE NOCASE
  ORDER BY id ASC
  LIMIT 1
`);

const updateToolAssignment = database.query(`
  UPDATE tools
  SET drawer_id = ?2,
      quantity = ?3,
      notes = ?4
  WHERE id = ?1
`);

const insertRequestLog = database.query(`
  INSERT INTO request_logs (method, path, tool, drawer_number, status_code, result, details)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
`);

const selectRequestLogs = database.query(`
  SELECT id,
         method,
         path,
         tool,
         drawer_number AS drawerNumber,
         status_code AS statusCode,
         result,
         details,
         created_at AS createdAt
  FROM request_logs
  ORDER BY id DESC
  LIMIT ?1
`);

function normalizeName(value: string, fieldName: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    throw new Error(`${fieldName} is required.`);
  }

  return trimmedValue;
}

export function listDrawers(): DrawerRecord[] {
  const drawers = selectDrawers.all() as Array<Omit<DrawerRecord, "toolCount" | "tools">>;
  const tools = selectTools.all() as ToolRecord[];
  const toolsByDrawerId = new Map<number, ToolRecord[]>();

  for (const tool of tools) {
    const drawerTools = toolsByDrawerId.get(tool.drawerId) ?? [];
    drawerTools.push(tool);
    toolsByDrawerId.set(tool.drawerId, drawerTools);
  }

  return drawers.map((drawer) => {
    const drawerTools = toolsByDrawerId.get(drawer.id) ?? [];

    return {
      ...drawer,
      toolCount: drawerTools.length,
      tools: drawerTools,
    };
  });
}

export function createDrawer(name: string) {
  const normalizedName = normalizeName(name, "Drawer name");

  try {
    const result = insertDrawer.run(normalizedName) as { lastInsertRowid: number | bigint };
    return selectDrawerById.get(Number(result.lastInsertRowid)) as Omit<DrawerRecord, "toolCount" | "tools">;
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      throw new Error("A drawer with that name already exists.");
    }

    throw error;
  }
}

export function addToolToDrawer(drawerId: number, tool: { name: string; quantity?: number; notes?: string }) {
  const existingDrawer = selectDrawerById.get(drawerId) as Omit<DrawerRecord, "toolCount" | "tools"> | null;

  if (!existingDrawer) {
    throw new Error("Drawer not found.");
  }

  const normalizedToolName = normalizeName(tool.name, "Tool name");
  const quantity = Number.isInteger(tool.quantity) && (tool.quantity as number) > 0 ? (tool.quantity as number) : 1;
  const notes = (tool.notes ?? "").trim();

  upsertTool.run(drawerId, normalizedToolName, quantity, notes);

  return selectToolByDrawerAndName.get(drawerId, normalizedToolName) as ToolRecord;
}

export function findToolDrawer(toolName: string) {
  const normalizedToolName = normalizeName(toolName, "Tool name");
  const tool = selectToolByName.get(normalizedToolName) as ToolRecord | null;

  if (!tool) {
    return null;
  }

  const drawer = selectDrawerById.get(tool.drawerId) as Omit<DrawerRecord, "toolCount" | "tools"> | null;

  if (!drawer) {
    return null;
  }

  return {
    tool: tool.name,
    drawerId: drawer.id,
    drawerName: drawer.name,
  };
}

export function assignToolToDrawer(drawerId: number, tool: { name: string; quantity?: number; notes?: string }) {
  const existingDrawer = selectDrawerById.get(drawerId) as Omit<DrawerRecord, "toolCount" | "tools"> | null;

  if (!existingDrawer) {
    throw new Error("Drawer not found.");
  }

  const normalizedToolName = normalizeName(tool.name, "Tool name");
  const quantity = Number.isInteger(tool.quantity) && (tool.quantity as number) > 0 ? (tool.quantity as number) : 1;
  const notes = (tool.notes ?? "").trim();
  const existingTool = selectToolByName.get(normalizedToolName) as ToolRecord | null;

  if (existingTool) {
    updateToolAssignment.run(existingTool.id, drawerId, quantity, notes);
    return selectToolByDrawerAndName.get(drawerId, normalizedToolName) as ToolRecord;
  }

  return addToolToDrawer(drawerId, {
    name: normalizedToolName,
    quantity,
    notes,
  });
}

export function recordRequestLog(log: {
  method: string;
  path: string;
  tool?: string;
  drawerNumber?: number | null;
  statusCode: number;
  result: string;
  details?: string;
}) {
  insertRequestLog.run(
    log.method,
    log.path,
    (log.tool ?? "").trim(),
    log.drawerNumber ?? null,
    log.statusCode,
    log.result,
    (log.details ?? "").trim(),
  );
}

export function listRequestLogs(limit = 50) {
  const normalizedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  return selectRequestLogs.all(normalizedLimit) as RequestLogRecord[];
}