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
  uptimeMs: number | null;
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

export type ToolMatchType = "exact" | "tokens" | "partial";

export type ToolQueryMatch = {
  toolName: string;
  matchType: ToolMatchType;
  // Every other tool that scored as well on a partial match. Empty for exact and
  // token matches, which are unambiguous by construction.
  alternatives: string[];
};

// One tool the query matched, with everywhere it lives.
export type ToolMatch = {
  tool: string;
  // The one location a caller should act on. Everything a display needs comes
  // from this single object, so a row and a label can never describe different
  // drawers. Null only when the tool is known but has no location at all.
  primaryLocation: ToolLocation | null;
  hasMultipleLocations: boolean;
  drawers: ToolLocation[];
  rows: Array<{ rowNumber: number; certainty: number | null }>;
};

export type ToolLookupResult = ToolMatch & {
  // How the query reached this tool. "exact" is the name as stored; the others
  // are the resolver's work, and a caller that cares about certainty - the
  // dashboard does, the firmware does not - can say so.
  matchType: ToolMatchType;
  // What was actually asked for, before resolution. Kept so a mishearing is
  // visible: "found Needle-nose Pliers for 'needle nose players'" is a diagnosis,
  // where "found Needle-nose Pliers" alone hides the interesting part.
  query: string;
  // Every tool the query matched, best first. The fields above describe
  // `matches[0]` and are kept flat so existing callers - the firmware among them -
  // do not have to change to keep working.
  //
  // More than one entry means the query was ambiguous: "screwdriver" when the box
  // owns three. Nothing here picks between them. The 8x8 matrix cannot show
  // several at once in a way anyone could read - six usable rows, and a lit row
  // says nothing about *which* tool it belongs to - so the firmware displays the
  // first and the rest wait for the LED strip, which is where row indication is
  // going anyway. See the Row Indication decision in the spec.
  matches: ToolMatch[];
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
    uptime_ms INTEGER,
    first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_drawer_name ON tools(drawer_id, name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_observations_tool_drawer ON drawer_observations(tool_name, drawer_id, id DESC);
`);

const deviceColumns = database.query("PRAGMA table_info(devices)").all() as Array<{ name: string }>;

if (deviceColumns.length > 0 && !deviceColumns.some((column) => column.name === "uptime_ms")) {
  database.exec("ALTER TABLE devices ADD COLUMN uptime_ms INTEGER");
}

const observationColumns = database.query("PRAGMA table_info(drawer_observations)").all() as Array<{ name: string }>;

// Reassigning a tool supersedes the observations that pinned it to its old
// drawer. They are kept rather than deleted: the camera did see the tool there,
// and that history is worth having - it just is not a current location.
if (!observationColumns.some((column) => column.name === "superseded_at")) {
  database.exec("ALTER TABLE drawer_observations ADD COLUMN superseded_at TEXT");
}

// Tool names are one identity, case-insensitively: lookups have always compared
// with COLLATE NOCASE, but the unique index was BINARY, so "Hammer" and "hammer"
// could sit in one drawer while every read treated them as the same tool. Old
// databases are merged into that rule once, then the index is swapped.
const toolIndex = database
  .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_tools_drawer_name'")
  .get() as { sql: string | null } | null;

if (toolIndex && toolIndex.sql && !/nocase/i.test(toolIndex.sql)) {
  // Fold only A-Z. SQLite's NOCASE is ASCII-only, and using toLowerCase() here
  // would merge pairs the new index would still consider distinct.
  const foldAscii = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

  const mergeCaseDuplicates = database.transaction(() => {
    const rows = database
      .query("SELECT id, drawer_id AS drawerId, name, quantity, notes FROM tools ORDER BY id ASC")
      .all() as Array<{ id: number; drawerId: number; name: string; quantity: number; notes: string }>;

    const groups = new Map<string, typeof rows>();

    for (const row of rows) {
      const key = JSON.stringify([row.drawerId, foldAscii(row.name)]);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    for (const group of groups.values()) {
      if (group.length < 2) {
        continue;
      }

      // The oldest row survives, and its capitalisation becomes the display
      // form. Quantities add up: they are the same tool counted twice.
      const [survivor, ...duplicates] = group as [typeof rows[number], ...typeof rows];
      const quantity = group.reduce((total, row) => total + row.quantity, 0);
      const notes = survivor.notes.trim() || duplicates.find((row) => row.notes.trim())?.notes || "";

      database.query("UPDATE tools SET quantity = ?2, notes = ?3 WHERE id = ?1").run(survivor.id, quantity, notes);

      for (const duplicate of duplicates) {
        database.query("DELETE FROM tools WHERE id = ?1").run(duplicate.id);
      }

      console.log(`[db] merged ${duplicates.length} case-duplicate tool row(s) into "${survivor.name}"`);
    }

    database.exec("DROP INDEX IF EXISTS idx_tools_drawer_name");
    database.exec("CREATE UNIQUE INDEX idx_tools_drawer_name ON tools(drawer_id, name COLLATE NOCASE)");
  });

  mergeCaseDuplicates();
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

const selectDrawersAboveRow = database.query(`
  SELECT name, row_number AS rowNumber
  FROM drawers
  WHERE row_number > ?1
  ORDER BY row_number ASC
`);

const insertDrawer = database.query(`
  INSERT INTO drawers (name, label, row_number)
  VALUES (?1, ?2, ?3)
`);

const upsertDeviceContact = database.query(`
  INSERT INTO devices (id, firmware_version, last_endpoint, last_seen, boot_count, uptime_ms)
  VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP, ?4, ?5)
  ON CONFLICT(id) DO UPDATE SET
    last_seen = CURRENT_TIMESTAMP,
    last_endpoint = excluded.last_endpoint,
    -- Only device/status carries a version. Every other endpoint sends an
    -- empty string, which must not blank out what the last heartbeat reported.
    firmware_version = CASE
      WHEN excluded.firmware_version <> '' THEN excluded.firmware_version
      ELSE devices.firmware_version
    END,
    -- The caller works the count out; SQL cannot see the previous uptime.
    boot_count = excluded.boot_count,
    uptime_ms = CASE
      WHEN excluded.uptime_ms IS NOT NULL THEN excluded.uptime_ms
      ELSE devices.uptime_ms
    END
`);

const selectDevice = database.query(`
  SELECT id,
         firmware_version AS firmwareVersion,
         last_endpoint AS lastEndpoint,
         last_seen AS lastSeen,
         boot_count AS bootCount,
         uptime_ms AS uptimeMs,
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
  ON CONFLICT(drawer_id, name COLLATE NOCASE)
  DO UPDATE SET
    quantity = excluded.quantity,
    notes = excluded.notes
`);

const selectToolByDrawerAndName = database.query(`
  SELECT id, drawer_id AS drawerId, name, quantity, notes, created_at AS createdAt
  FROM tools
  WHERE drawer_id = ?1 AND name = ?2 COLLATE NOCASE
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

// request_logs is diagnostics, not an audit trail. Nothing reads it back except
// the dashboard's Recent Requests panel, which asks for at most 200 rows, so
// keeping it forever buys nothing and costs steady writes to the Pi's SD card.
export const REQUEST_LOG_RETENTION_DAYS = 30;

const deleteExpiredRequestLogs = database.query(`
  DELETE FROM request_logs
  WHERE created_at < datetime('now', ?1)
`);

// Pruned from the write path rather than on a timer: no interval to keep alive,
// nothing to clean up on shutdown, and a server nobody is using does no work.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPrunedAt = 0;

export function pruneRequestLogs() {
  const result = deleteExpiredRequestLogs.run(`-${REQUEST_LOG_RETENTION_DAYS} days`);
  lastPrunedAt = Date.now();

  return Number(result.changes ?? 0);
}

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
  const rowNumber = normalizeRowNumber(location?.rowNumber);

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

    // Defensive. The unique index on (drawer_id, name COLLATE NOCASE) means no
    // other row of this name can remain in the source drawer, so this is always
    // true today - but superseding observations for a tool that is still there
    // would be silent data loss, and the guard costs one indexed lookup.
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

  if (Date.now() - lastPrunedAt > PRUNE_INTERVAL_MS) {
    const removed = pruneRequestLogs();

    if (removed > 0) {
      console.log(`[db] pruned ${removed} request log(s) older than ${REQUEST_LOG_RETENTION_DAYS} days`);
    }
  }
}

export function listRequestLogs(limit = 50) {
  const normalizedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  return selectRequestLogs.all(normalizedLimit) as RequestLogRecord[];
}

function getConfigValue(key: string, fallback: string) {
  const row = selectConfigValue.get(key) as { value: string } | null;
  return row?.value ?? fallback;
}

// How many indicator rows the toolbox in front of the panel actually has. Not a
// constant, because a seven- or eight-drawer-row box is a perfectly reasonable
// thing to own - but the 8x8 matrix is a hard ceiling, since a panel with eight
// rows cannot point at a ninth however big the box is.
export const MAX_TOOLBOX_ROWS = 8;
export const DEFAULT_TOOLBOX_ROWS = 6;

export function getToolboxRowCount(): number {
  const stored = Number(getConfigValue("toolbox_row_count", String(DEFAULT_TOOLBOX_ROWS)));

  return Number.isInteger(stored) && stored >= 1 && stored <= MAX_TOOLBOX_ROWS
    ? stored
    : DEFAULT_TOOLBOX_ROWS;
}

export function saveToolboxRowCount(rowCount: number) {
  if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > MAX_TOOLBOX_ROWS) {
    throw new Error(`Toolbox rows must be a whole number between 1 and ${MAX_TOOLBOX_ROWS}.`);
  }

  // Shrinking past a drawer that is already using a high row would strand it:
  // the row would stay in the database and simply stop being indicatable. Refuse
  // and name the drawers, rather than silently orphaning them.
  const stranded = selectDrawersAboveRow.all(rowCount) as Array<{ name: string; rowNumber: number }>;

  if (stranded.length > 0) {
    const named = stranded.map((drawer) => `${drawer.name} (row ${drawer.rowNumber})`).join(", ");
    throw new Error(`Cannot reduce to ${rowCount} rows while these drawers use a higher row: ${named}.`);
  }

  upsertConfigValue.run("toolbox_row_count", String(rowCount));

  return getToolboxRowCount();
}

// A drawer's row has to be one the panel can actually light. The bound is read
// at call time rather than captured, so changing the setting takes effect
// without a restart.
function normalizeRowNumber(rowNumber: number | undefined | null) {
  if (rowNumber === undefined || rowNumber === null) {
    return null;
  }

  const rowCount = getToolboxRowCount();

  if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > rowCount) {
    throw new Error(`Matrix row must be a whole number between 1 and ${rowCount}.`);
  }

  return rowNumber;
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

// Whisper hands over what a person said - "where are my needle nose pliers" -
// and the database holds "Needle-nose Pliers". Exact matching returns nothing and
// the box says "not found" for a tool it owns.
//
// Carrier words people actually say around a tool name. Dropped before matching,
// because they carry no information about which tool is wanted and every one of
// them would otherwise have to appear in the stored name.
const CARRIER_WORDS = new Set([
  "where", "is", "are", "was", "were", "find", "get", "show", "me", "i", "need",
  "want", "my", "the", "a", "an", "please", "in", "on", "at", "of", "to", "for",
  "drawer", "tool", "box", "toolbox", "s",
]);

// Words too common across a toolbox to identify anything on their own. A partial
// match needs at least one token that is *not* in here, or "screwdriver" would
// confidently pick one of three screwdrivers - see resolveToolQuery.
const GENERIC_WORDS = new Set([
  "screwdriver", "wrench", "pliers", "plier", "hammer", "saw", "drill", "bit",
  "bits", "key", "keys", "set", "socket", "driver", "cutter", "cutters", "tape",
]);

function normalizeForMatching(value: string) {
  return value
    .toLowerCase()
    // Hyphens become spaces so "needle-nose" and "needle nose" are one thing.
    .replace(/[-_/]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Crude, and deliberately so: only a trailing "s" or "es". Anything cleverer
// starts mangling real tool names, and the token match is already forgiving
// enough that a missed plural rarely decides the outcome.
function singular(token: string) {
  if (token.length > 3 && token.endsWith("es")) {
    return token.slice(0, -2);
  }

  if (token.length > 2 && token.endsWith("s")) {
    return token.slice(0, -1);
  }

  return token;
}

function meaningfulTokens(value: string) {
  return normalizeForMatching(value)
    .split(" ")
    .filter((token) => token.length > 0 && !CARRIER_WORDS.has(token))
    .map(singular);
}

const selectAllToolNames = database.query(`
  SELECT name FROM tools
  UNION
  SELECT tool_name AS name FROM drawer_observations WHERE superseded_at IS NULL
`);

// Returns the tool a query means, or null. Three tiers, first hit wins, and the
// tier is reported rather than hidden - a caller that wants to distinguish a
// certainty from a guess can, and the dashboard does.
export function resolveToolQuery(query: string): ToolQueryMatch | null {
  const trimmed = query.trim();

  if (!trimmed) {
    return null;
  }

  // Tier 1: exact, unchanged and still first. A stored name that happens to
  // contain a carrier word still resolves, because nothing is stripped here.
  const exact = selectCanonicalToolName.get(trimmed) as { name: string } | null;
  if (exact) {
    return { toolName: exact.name, matchType: "exact", alternatives: [] };
  }

  const queryTokens = meaningfulTokens(trimmed);
  if (queryTokens.length === 0) {
    return null; // Carrier words only - "where is the" names no tool.
  }

  const names = (selectAllToolNames.all() as Array<{ name: string }>).map((row) => row.name);

  // Tier 2: every query token appears in the tool name. "needle nose pliers"
  // matches "Needle-nose Pliers". Shortest name wins a tie, because it is the
  // one with the least unmatched left over - the most specific fit.
  const tokenHits = names
    .filter((name) => {
      const nameTokens = new Set(meaningfulTokens(name));
      return queryTokens.every((token) => nameTokens.has(token));
    })
    .sort((left, right) => left.length - right.length);

  if (tokenHits.length > 0) {
    return { toolName: tokenHits[0], matchType: "tokens", alternatives: tokenHits.slice(1) };
  }

  // Tier 3: best token overlap, but only on the strength of a distinctive word.
  // Without that rule "screwdriver" silently picks one of three screwdrivers;
  // with it, all three come back as alternatives and the matrix lights every row
  // they are in, which the rows array already supports.
  let best = 0;
  const scored = names
    .map((name) => {
      const nameTokens = new Set(meaningfulTokens(name));
      const shared = queryTokens.filter((token) => nameTokens.has(token));
      const distinctive = shared.some((token) => !GENERIC_WORDS.has(token));
      return { name, score: distinctive ? shared.length : 0 };
    })
    .filter((entry) => entry.score > 0);

  for (const entry of scored) {
    best = Math.max(best, entry.score);
  }

  if (best === 0) {
    return null;
  }

  const winners = scored
    .filter((entry) => entry.score === best)
    .map((entry) => entry.name)
    .sort((left, right) => left.length - right.length);

  return { toolName: winners[0], matchType: "partial", alternatives: winners.slice(1) };
}

// Everywhere one named tool lives. Lifted out of findToolLocations so that an
// ambiguous query gets the same treatment for every tool it matched, rather than
// full detail for the winner and a bare name for the rest.
function locateTool(tool: string): ToolMatch {
  const drawers = selectToolLocations.all(tool) as ToolLocation[];
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
    tool,
    primaryLocation: pickPrimaryLocation(drawers),
    hasMultipleLocations: drawers.length > 1,
    drawers,
    rows: [...rowsByNumber.entries()].map(([rowNumber, certainty]) => ({ rowNumber, certainty })),
  };
}

export function findToolLocations(toolName: string): ToolLookupResult | null {
  const normalizedToolName = normalizeName(toolName, "Tool name");

  // Deliberately here rather than on a voice-only path: tools/lookup over serial,
  // the HTTP endpoint and the dashboard all gain fuzzy matching from one change,
  // and there is no second code path to keep in step.
  const match = resolveToolQuery(normalizedToolName);

  if (!match) {
    return null;
  }

  const matches = [match.toolName, ...match.alternatives].map(locateTool);

  return {
    ...matches[0],
    matchType: match.matchType,
    query: normalizedToolName,
    matches,
  };
}

export type DrawerObservation = {
  drawerId: number;
  toolName: string;
  quantity?: number;
  confidence: number;
  modelVersion?: string;
};

function validateObservation(observation: DrawerObservation) {
  const toolName = normalizeName(observation.toolName, "Tool name");
  const quantity = Number.isInteger(observation.quantity) && (observation.quantity as number) > 0
    ? observation.quantity as number
    : 1;
  const confidence = Math.round(observation.confidence);

  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) {
    throw new Error("Observation confidence must be between 0 and 100.");
  }

  return { toolName, quantity, confidence, modelVersion: (observation.modelVersion ?? "").trim() };
}

// Validates the whole batch before writing any of it, then writes it in one
// transaction. Doing this per detection meant a batch whose third item was bad
// left the first two committed and still answered 400 - so the caller saw a
// failure, retried, and doubled the rows that had already landed.
export function recordDrawerObservations(observations: DrawerObservation[]) {
  if (observations.length === 0) {
    throw new Error("At least one detection is required.");
  }

  // Drawer ids are checked up front too: a batch naming a drawer that does not
  // exist should write nothing, not everything before it.
  for (const observation of observations) {
    if (!selectDrawerById.get(observation.drawerId)) {
      throw new Error("Drawer not found.");
    }
  }

  const validated = observations.map((observation) => ({
    drawerId: observation.drawerId,
    ...validateObservation(observation),
  }));

  const write = database.transaction(() => {
    for (const observation of validated) {
      insertObservation.run(
        observation.drawerId,
        observation.toolName,
        observation.quantity,
        observation.confidence,
        observation.modelVersion,
      );
    }
  });

  write();

  return validated.length;
}

export function recordDrawerObservation(observation: DrawerObservation) {
  recordDrawerObservations([observation]);
}

export function findDrawerByLabel(label: string) {
  const normalizedLabel = normalizeName(label, "Drawer label");
  return selectDrawerByLabel.get(normalizedLabel) as Omit<DrawerRecord, "toolCount" | "tools"> | null;
}

// The XIAO speaks only over the serial wire and sends no identifier of its own,
// so every contact folds into this one row.
export const DEVICE_ID = "xiao";

// Reboots are detected from uptime running backwards, not from a boot message.
// The device announces itself while its USB serial port is still re-enumerating,
// so the Pi is often not listening yet and the announcement is simply lost -
// which is how boot_count sat at zero through several confirmed reboots. Uptime
// rides on every heartbeat, so a restart is noticed within one interval whether
// or not the announcement survived.
export function recordDeviceContact(contact: {
  endpoint: string;
  firmwareVersion?: string;
  uptimeMs?: number;
}) {
  const uptimeMs = Number.isFinite(contact.uptimeMs) ? Math.trunc(contact.uptimeMs as number) : null;

  const record = database.transaction(() => {
    const existing = getDeviceStatus();
    let bootCount = existing?.bootCount ?? 0;

    if (!existing) {
      bootCount = 1;
    } else if (uptimeMs != null && existing.uptimeMs != null && uptimeMs < existing.uptimeMs) {
      // millis() wraps after roughly 49.7 days, which reads as a reboot. That is
      // a miscount once every seven weeks of unbroken uptime, against catching
      // every real restart - the trade is worth making.
      bootCount += 1;
    }

    upsertDeviceContact.run(
      DEVICE_ID,
      (contact.firmwareVersion ?? "").trim(),
      contact.endpoint,
      bootCount,
      uptimeMs,
    );
  });

  record();
}

export function getDeviceStatus(): DeviceRecord | null {
  return selectDevice.get(DEVICE_ID) as DeviceRecord | null;
}