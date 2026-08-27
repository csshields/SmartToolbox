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
  label: string;
  rowNumber: number | null;
  createdAt: string;
  toolCount: number;
  tools: ToolRecord[];
};

export type ToolLocation = {
  drawerId: number;
  label: string;
  rowNumber: number | null;
  quantity: number;
  confidence: number | null;
  observedAt: string | null;
};

export type ToolLookupResult = {
  tool: string;
  drawers: ToolLocation[];
  rows: Array<{ rowNumber: number; certainty: number | null }>;
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

export type TranscriptionSettings = {
  provider: "nas_whisper" | "openai";
  nasUrl: string;
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
    label TEXT,
    row_number INTEGER,
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

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS drawer_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drawer_id INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 1),
    confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
    model_version TEXT NOT NULL DEFAULT '',
    observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(drawer_id) REFERENCES drawers(id) ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_drawer_name ON tools(drawer_id, name);
  CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_observations_tool_drawer ON drawer_observations(tool_name, drawer_id, id DESC);
`);

const drawerColumns = database.query("PRAGMA table_info(drawers)").all() as Array<{ name: string }>;

if (!drawerColumns.some((column) => column.name === "label")) {
  database.exec("ALTER TABLE drawers ADD COLUMN label TEXT");
}

if (!drawerColumns.some((column) => column.name === "row_number")) {
  database.exec("ALTER TABLE drawers ADD COLUMN row_number INTEGER");
}

database.exec(`
  UPDATE drawers
  SET label = COALESCE(label, name),
      row_number = COALESCE(
        row_number,
        CASE WHEN name GLOB 'Drawer [0-9]*' THEN CAST(SUBSTR(name, 8) AS INTEGER) END
      )
`);

const selectDrawers = database.query(`
  SELECT id, name, COALESCE(label, name) AS label, row_number AS rowNumber, created_at AS createdAt
  FROM drawers
  ORDER BY row_number ASC, label COLLATE NOCASE ASC
`);

const selectTools = database.query(`
  SELECT id, drawer_id AS drawerId, name, quantity, notes, created_at AS createdAt
  FROM tools
  ORDER BY name COLLATE NOCASE ASC
`);

const selectDrawerById = database.query(`
  SELECT id, name, COALESCE(label, name) AS label, row_number AS rowNumber, created_at AS createdAt
  FROM drawers
  WHERE id = ?1
`);

const selectDrawerByLabel = database.query(`
  SELECT id, name, COALESCE(label, name) AS label, row_number AS rowNumber, created_at AS createdAt
  FROM drawers
  WHERE COALESCE(label, name) = ?1 COLLATE NOCASE
`);

const insertDrawer = database.query(`
  INSERT INTO drawers (name, label, row_number)
  VALUES (?1, ?2, ?3)
`);

const deleteDrawerById = database.query(`
  DELETE FROM drawers
  WHERE id = ?1
`);

const deleteToolByDrawerAndId = database.query(`
  DELETE FROM tools
  WHERE drawer_id = ?1 AND id = ?2
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

const selectToolLocations = database.query(`
  WITH latest_observations AS (
    SELECT drawer_id, tool_name, quantity, confidence, observed_at,
           ROW_NUMBER() OVER (PARTITION BY drawer_id, tool_name ORDER BY id DESC) AS position
    FROM drawer_observations
    WHERE tool_name = ?1 COLLATE NOCASE
  )
  SELECT drawer.id AS drawerId,
         COALESCE(drawer.label, drawer.name) AS label,
         drawer.row_number AS rowNumber,
         COALESCE(observation.quantity, tool.quantity) AS quantity,
         observation.confidence AS confidence,
         observation.observed_at AS observedAt
  FROM drawers AS drawer
  LEFT JOIN tools AS tool
    ON tool.drawer_id = drawer.id AND tool.name = ?1 COLLATE NOCASE
  LEFT JOIN latest_observations AS observation
    ON observation.drawer_id = drawer.id AND observation.position = 1
  WHERE tool.id IS NOT NULL OR observation.drawer_id IS NOT NULL
  ORDER BY drawer.row_number ASC, label COLLATE NOCASE ASC
`);

const selectCanonicalToolName = database.query(`
  SELECT name
  FROM tools
  WHERE name = ?1 COLLATE NOCASE
  UNION
  SELECT tool_name AS name
  FROM drawer_observations
  WHERE tool_name = ?1 COLLATE NOCASE
  LIMIT 1
`);

const insertObservation = database.query(`
  INSERT INTO drawer_observations (drawer_id, tool_name, quantity, confidence, model_version)
  VALUES (?1, ?2, ?3, ?4, ?5)
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

const selectConfigValue = database.query(`
  SELECT value
  FROM config
  WHERE key = ?1
`);

const upsertConfigValue = database.query(`
  INSERT INTO config (key, value, updated_at)
  VALUES (?1, ?2, CURRENT_TIMESTAMP)
  ON CONFLICT(key)
  DO UPDATE SET
    value = excluded.value,
    updated_at = CURRENT_TIMESTAMP
`);

const defaultTranscriptionSettings: TranscriptionSettings = {
  provider: "nas_whisper",
  nasUrl: "http://192.168.50.10:9000",
};

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

export function createDrawer(name: string, location?: { label?: string; rowNumber?: number }) {
  const normalizedName = normalizeName(name, "Drawer name");
  const label = (location?.label ?? normalizedName).trim() || normalizedName;
  const rowNumber = Number.isInteger(location?.rowNumber) && (location?.rowNumber as number) > 0
    ? location?.rowNumber as number
    : null;

  try {
    const result = insertDrawer.run(normalizedName, label, rowNumber) as { lastInsertRowid: number | bigint };
    return selectDrawerById.get(Number(result.lastInsertRowid)) as Omit<DrawerRecord, "toolCount" | "tools">;
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      throw new Error("A drawer with that name already exists.");
    }

    throw error;
  }
}

// Returns whether a row was actually removed, so the route can answer 404
// rather than reporting success for an id that was never there. The cascade is
// wider than the drawer: tools and drawer_observations both reference drawers
// with ON DELETE CASCADE, so this destroys the drawer's observation history too.
export function deleteDrawer(drawerId: number) {
  return deleteDrawerById.run(drawerId).changes > 0;
}

// Scoped by drawer as well as tool id, so a mismatched pair is a 404 instead of
// silently deleting a tool that belongs to a different drawer.
export function deleteTool(drawerId: number, toolId: number) {
  return deleteToolByDrawerAndId.run(drawerId, toolId).changes > 0;
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

function getConfigValue(key: string, fallback: string) {
  const row = selectConfigValue.get(key) as { value: string } | null;
  return row?.value ?? fallback;
}

export function getTranscriptionSettings(): TranscriptionSettings {
  const provider = getConfigValue("transcription_provider", defaultTranscriptionSettings.provider);

  return {
    provider: provider === "openai" ? "openai" : "nas_whisper",
    nasUrl: getConfigValue("transcription_nas_url", defaultTranscriptionSettings.nasUrl),
  };
}

export function saveTranscriptionSettings(settings: TranscriptionSettings) {
  upsertConfigValue.run("transcription_provider", settings.provider);
  upsertConfigValue.run("transcription_nas_url", settings.nasUrl);
  return getTranscriptionSettings();
}

export function findToolLocations(toolName: string): ToolLookupResult | null {
  const normalizedToolName = normalizeName(toolName, "Tool name");
  const canonicalTool = selectCanonicalToolName.get(normalizedToolName) as { name: string } | null;

  if (!canonicalTool) {
    return null;
  }

  const drawers = selectToolLocations.all(canonicalTool.name) as ToolLocation[];
  const rowsByNumber = new Map<number, number | null>();

  for (const drawer of drawers) {
    if (drawer.rowNumber == null) {
      continue;
    }

    const existingCertainty = rowsByNumber.get(drawer.rowNumber);
    if (existingCertainty === undefined || (drawer.confidence ?? -1) > (existingCertainty ?? -1)) {
      rowsByNumber.set(drawer.rowNumber, drawer.confidence);
    }
  }

  return {
    tool: canonicalTool.name,
    drawers,
    rows: [...rowsByNumber.entries()].map(([rowNumber, certainty]) => ({ rowNumber, certainty })),
  };
}

export function recordDrawerObservation(observation: {
  drawerId: number;
  toolName: string;
  quantity?: number;
  confidence: number;
  modelVersion?: string;
}) {
  const drawer = selectDrawerById.get(observation.drawerId) as Omit<DrawerRecord, "toolCount" | "tools"> | null;

  if (!drawer) {
    throw new Error("Drawer not found.");
  }

  const toolName = normalizeName(observation.toolName, "Tool name");
  const quantity = Number.isInteger(observation.quantity) && (observation.quantity as number) > 0
    ? observation.quantity as number
    : 1;
  const confidence = Math.round(observation.confidence);

  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) {
    throw new Error("Observation confidence must be between 0 and 100.");
  }

  insertObservation.run(observation.drawerId, toolName, quantity, confidence, (observation.modelVersion ?? "").trim());
}

export function findDrawerByLabel(label: string) {
  const normalizedLabel = normalizeName(label, "Drawer label");
  return selectDrawerByLabel.get(normalizedLabel) as Omit<DrawerRecord, "toolCount" | "tools"> | null;
}