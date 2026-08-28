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

export type DeviceRecord = {
  id: string;
  firmwareVersion: string;
  lastEndpoint: string;
  lastSeen: string;
  bootCount: number;
  firstSeen: string;
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
  // The one location a caller should act on. Everything a display needs comes
  // from this single object, so a row and a label can never describe different
  // drawers. Null only when the tool is known but has no location at all.
  primaryLocation: ToolLocation | null;
  hasMultipleLocations: boolean;
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

  -- One row per device. There is exactly one XIAO on exactly one wire, so the
  -- id is a constant rather than anything the device reports - the serial
  -- protocol carries no device identifier.
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    firmware_version TEXT NOT NULL DEFAULT '',
    last_endpoint TEXT NOT NULL DEFAULT '',
    last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    boot_count INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_drawer_name ON tools(drawer_id, name);
  CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_observations_tool_drawer ON drawer_observations(tool_name, drawer_id, id DESC);
`);

const observationColumns = database.query("PRAGMA table_info(drawer_observations)").all() as Array<{ name: string }>;

// Reassigning a tool supersedes the observations that pinned it to its old
// drawer. They are kept rather than deleted: the camera did see the tool there,
// and that history is worth having - it just is not a current location.
if (!observationColumns.some((column) => column.name === "superseded_at")) {
  database.exec("ALTER TABLE drawer_observations ADD COLUMN superseded_at TEXT");
}

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

const upsertDeviceContact = database.query(`
  INSERT INTO devices (id, firmware_version, last_endpoint, last_seen, boot_count)
  VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP, ?4)
  ON CONFLICT(id) DO UPDATE SET
    last_seen = CURRENT_TIMESTAMP,
    last_endpoint = excluded.last_endpoint,
    -- Only device/status carries a version. Every other endpoint sends an
    -- empty string, which must not blank out what the last boot reported.
    firmware_version = CASE
      WHEN excluded.firmware_version <> '' THEN excluded.firmware_version
      ELSE devices.firmware_version
    END,
    boot_count = devices.boot_count + excluded.boot_count
`);

const selectDevice = database.query(`
  SELECT id,
         firmware_version AS firmwareVersion,
         last_endpoint AS lastEndpoint,
         last_seen AS lastSeen,
         boot_count AS bootCount,
         first_seen AS firstSeen
  FROM devices
  WHERE id = ?1
`);

const deleteDrawerById = database.query(`
  DELETE FROM drawers
  WHERE id = ?1
`);

const selectToolByDrawerAndId = database.query(`
  SELECT name
  FROM tools
  WHERE drawer_id = ?1 AND id = ?2
`);

const deleteToolByDrawerAndId = database.query(`
  DELETE FROM tools
  WHERE drawer_id = ?1 AND id = ?2
`);

const deleteObservationsForTool = database.query(`
  DELETE FROM drawer_observations
  WHERE drawer_id = ?1 AND tool_name = ?2 COLLATE NOCASE
`);

const selectToolById = database.query(`
  SELECT id, drawer_id AS drawerId, name, quantity, notes, created_at AS createdAt
  FROM tools
  WHERE id = ?1
`);

// "Is there some other tool called this in that drawer?" - asked twice during a
// reassignment, of the target drawer and then of the source. Case-insensitive
// because the unique index on (drawer_id, name) uses BINARY, so "Hammer" and
// "hammer" can both sit in one drawer and both have to count. Excluding the
// moving tool by id keeps a move into its own drawer from colliding with itself.
const selectOtherToolNamed = database.query(`
  SELECT id
  FROM tools
  WHERE drawer_id = ?1 AND name = ?2 COLLATE NOCASE AND id <> ?3
  LIMIT 1
`);

const supersedeObservationsForTool = database.query(`
  UPDATE drawer_observations
  SET superseded_at = CURRENT_TIMESTAMP
  WHERE drawer_id = ?1 AND tool_name = ?2 COLLATE NOCASE AND superseded_at IS NULL
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
           ROW_NUMBER() OVER (PARTITION BY drawer_id ORDER BY id DESC) AS position
    FROM drawer_observations
    WHERE tool_name = ?1 COLLATE NOCASE AND superseded_at IS NULL
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
  WHERE tool_name = ?1 COLLATE NOCASE AND superseded_at IS NULL
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

// Deletes the tool's observations along with the tool row. Without this the
// tool stays findable: selectCanonicalToolName UNIONs drawer_observations, and
// selectToolLocations matches on `tool.id IS NOT NULL OR observation.drawer_id
// IS NOT NULL`. An orphaned observation therefore keeps answering tools/lookup
// with full confidence while the dashboard shows the drawer as empty - the
// device would keep pointing at a tool the user believes they deleted, forever.
// Deleting a drawer never had this problem: observations cascade on drawer_id.
//
// Scoped by drawer as well as tool id, so a mismatched pair is a 404 instead of
// silently deleting a tool that belongs to a different drawer.
const deleteToolAndObservations = database.transaction((drawerId: number, toolId: number, toolName: string) => {
  deleteToolByDrawerAndId.run(drawerId, toolId);
  deleteObservationsForTool.run(drawerId, toolName);
});

export function deleteTool(drawerId: number, toolId: number) {
  const tool = selectToolByDrawerAndId.get(drawerId, toolId) as { name: string } | null;

  if (!tool) {
    return false;
  }

  deleteToolAndObservations(drawerId, toolId, tool.name);
  return true;
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

export class ToolNameConflictError extends Error {}

// Moves an existing tool between drawers. Keyed on the tool's id, not its name:
// a name is not unique across drawers, and the old name-based lookup took the
// lowest id, so asking to move "hammer" could silently move a different drawer's
// "Hammer" instead. There is no create-by-name here either - use addToolToDrawer.
//
// The observations matter as much as the tool row. selectToolLocations admits a
// drawer when *either* a tool row or a live observation points at it, so moving
// the row alone leaves the source drawer reported as a current location - and,
// because the stale row carries the camera's confidence while the freshly moved
// tool has none, reported as the *more* confident of the two. The device would
// light the drawer the tool just left.
export function assignToolToDrawer(drawerId: number, tool: { toolId: number; quantity?: number; notes?: string }) {
  const existingDrawer = selectDrawerById.get(drawerId) as Omit<DrawerRecord, "toolCount" | "tools"> | null;

  if (!existingDrawer) {
    throw new Error("Drawer not found.");
  }

  if (!Number.isInteger(tool.toolId) || tool.toolId < 1) {
    throw new Error("Tool id is required.");
  }

  const existingTool = selectToolById.get(tool.toolId) as ToolRecord | null;

  if (!existingTool) {
    throw new Error("Tool not found.");
  }

  if (selectOtherToolNamed.get(drawerId, existingTool.name, existingTool.id)) {
    throw new ToolNameConflictError("A tool with that name is already in the target drawer.");
  }

  const quantity = Number.isInteger(tool.quantity) && (tool.quantity as number) > 0 ? (tool.quantity as number) : existingTool.quantity;
  const notes = tool.notes === undefined ? existingTool.notes : tool.notes.trim();
  const sourceDrawerId = existingTool.drawerId;

  // One transaction: a moved tool whose old observations survived would be worse
  // than not having moved it at all, since both drawers would then claim it.
  const move = database.transaction(() => {
    updateToolAssignment.run(existingTool.id, drawerId, quantity, notes);

    // Only when nothing of that name is left behind. A case variant still in the
    // source drawer means the camera's sighting there is still about a real tool.
    const sourceNowEmptyOfThisName = sourceDrawerId !== drawerId
      && !selectOtherToolNamed.get(sourceDrawerId, existingTool.name, existingTool.id);

    if (sourceNowEmptyOfThisName) {
      supersedeObservationsForTool.run(sourceDrawerId, existingTool.name);
    }
  });

  move();

  // Read back by id. The old code read back by (drawer, name) without COLLATE
  // NOCASE, so a case-variant move returned null and the caller reported a
  // failure for a write that had already happened.
  return selectToolById.get(existingTool.id) as ToolRecord;
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

// Which of several candidate drawers to point the user at.
//
// 1. A drawer with a row number beats one without. The device indicates a row
//    and nothing else, so a location it cannot show is useless as the primary.
// 2. Then the highest confidence, matching how `rows` already collapses. A null
//    confidence means the camera has never seen the tool there, so it sorts
//    last rather than counting as certainty.
// 3. Then lowest row number, then lowest drawer id, purely so the answer is
//    stable rather than dependent on SQLite's row order.
function pickPrimaryLocation(locations: ToolLocation[]): ToolLocation | null {
  if (locations.length === 0) {
    return null;
  }

  return [...locations].sort((a, b) => {
    const aHasRow = a.rowNumber != null;
    const bHasRow = b.rowNumber != null;

    if (aHasRow !== bHasRow) {
      return aHasRow ? -1 : 1;
    }

    const confidenceGap = (b.confidence ?? -1) - (a.confidence ?? -1);

    if (confidenceGap !== 0) {
      return confidenceGap;
    }

    const rowGap = (a.rowNumber ?? Number.MAX_SAFE_INTEGER) - (b.rowNumber ?? Number.MAX_SAFE_INTEGER);

    return rowGap !== 0 ? rowGap : a.drawerId - b.drawerId;
  })[0]!;
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
    primaryLocation: pickPrimaryLocation(drawers),
    hasMultipleLocations: drawers.length > 1,
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

// The XIAO speaks only over the serial wire and sends no identifier of its own,
// so every contact folds into this one row.
export const DEVICE_ID = "xiao";

export function recordDeviceContact(contact: { endpoint: string; firmwareVersion?: string }) {
  // device/status is the firmware's boot announcement and nothing else sends it,
  // so it is also the only thing that counts as a boot.
  const isBoot = contact.endpoint === "device/status" ? 1 : 0;

  upsertDeviceContact.run(
    DEVICE_ID,
    (contact.firmwareVersion ?? "").trim(),
    contact.endpoint,
    isBoot,
  );
}

export function getDeviceStatus(): DeviceRecord | null {
  return selectDevice.get(DEVICE_ID) as DeviceRecord | null;
}