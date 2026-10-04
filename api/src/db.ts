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
  toolboxId: number;
  toolboxName: string;
  name: string;
  label: string;
  rowNumber: number | null;
  createdAt: string;
  toolCount: number;
  tools: ToolRecord[];
};

export type ToolboxRecord = {
  id: number;
  name: string;
  rowCount: number;
  // The box the XIAO is mounted on. Exactly one toolbox can say so: the device
  // lights rows on that box and on no other.
  hasDevice: boolean;
  drawerCount: number;
  createdAt: string;
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
  toolboxId: number;
  toolboxName: string;
  // Whether this drawer is in the box the device is mounted on. A row number in
  // any other box is real, but lighting it would point at the wrong toolbox.
  onDevice: boolean;
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
  // Every other tool that matched as well as this one. Empty only for an exact
  // match, which names one stored tool by definition; a token match can be
  // ambiguous too - "screwdriver" matches every screwdriver in the box - so a
  // caller that cares about certainty has to read this, not the matchType.
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

  CREATE TABLE IF NOT EXISTS toolboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    row_count INTEGER NOT NULL DEFAULT 6 CHECK (row_count >= 1 AND row_count <= 8),
    has_device INTEGER NOT NULL DEFAULT 0 CHECK (has_device IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- At most one box carries the device. Enforced here rather than trusted to
  -- the code that moves it, which clears the old flag before setting the new.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_toolboxes_device ON toolboxes(has_device) WHERE has_device = 1;

  CREATE TABLE IF NOT EXISTS drawers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    toolbox_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    label TEXT,
    row_number INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(toolbox_id) REFERENCES toolboxes(id) ON DELETE CASCADE
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

// How many indicator rows a toolbox can have. The 8x8 matrix is a hard ceiling,
// since a panel with eight rows cannot point at a ninth however big the box is.
export const MAX_TOOLBOX_ROWS = 8;
export const DEFAULT_TOOLBOX_ROWS = 6;

// Every database has at least one toolbox, and the first one carries the device.
// On an older database it inherits the row count that used to live in config,
// so upgrading changes nothing about what the panel will light.
if (!database.query("SELECT id FROM toolboxes LIMIT 1").get()) {
  const legacy = database.query("SELECT value FROM config WHERE key = 'toolbox_row_count'").get() as { value: string } | null;
  const legacyRows = Number(legacy?.value);
  const rowCount = Number.isInteger(legacyRows) && legacyRows >= 1 && legacyRows <= MAX_TOOLBOX_ROWS
    ? legacyRows
    : DEFAULT_TOOLBOX_ROWS;

  database.query("INSERT INTO toolboxes (name, row_count, has_device) VALUES ('Toolbox', ?1, 1)").run(rowCount);
}

// Drawers predating toolboxes had a globally unique name, which would stop two
// boxes each having a "Drawer 1". SQLite cannot drop a UNIQUE constraint in
// place, so the table is rebuilt: the documented copy, drop and rename, with
// foreign keys off so that dropping the old table does not cascade into tools
// and drawer_observations. Ids are copied as they are, so every reference to a
// drawer still points at the same drawer afterwards.
const drawerColumnsBeforeToolboxes = database.query("PRAGMA table_info(drawers)").all() as Array<{ name: string }>;

if (!drawerColumnsBeforeToolboxes.some((column) => column.name === "toolbox_id")) {
  const home = database.query("SELECT id FROM toolboxes ORDER BY has_device DESC, id ASC LIMIT 1").get() as { id: number };

  // Counted before as well as after, because a database can already hold
  // orphans - tools whose drawer was deleted while foreign keys were off. Those
  // are not this rebuild's doing, and refusing to start over them would take the
  // whole API down for rows that nothing can reach anyway.
  const orphansBefore = database.query("PRAGMA foreign_key_check").all().length;

  database.exec("PRAGMA foreign_keys = OFF");

  try {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE drawers_rebuilt (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          toolbox_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          label TEXT,
          row_number INTEGER,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(toolbox_id) REFERENCES toolboxes(id) ON DELETE CASCADE
        )
      `);
      database
        .query(`
          INSERT INTO drawers_rebuilt (id, toolbox_id, name, label, row_number, created_at)
          SELECT id, ?1, name, label, row_number, created_at FROM drawers
        `)
        .run(home.id);
      database.exec("DROP TABLE drawers");
      database.exec("ALTER TABLE drawers_rebuilt RENAME TO drawers");

      // Throwing here rolls the whole rebuild back, leaving the old table as it was.
      const orphansAfter = database.query("PRAGMA foreign_key_check").all().length;
      if (orphansAfter > orphansBefore) {
        throw new Error(`Drawer rebuild broke ${orphansAfter - orphansBefore} reference(s); rolled back.`);
      }
    })();
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }

  console.log(`[db] moved existing drawers into toolbox ${home.id}`);
}

// BINARY, matching the UNIQUE it replaces: a NOCASE index could refuse to build
// over names that the old constraint happily allowed.
database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_drawers_toolbox_name ON drawers(toolbox_id, name)");

const drawerFields = `
  drawer.id, drawer.toolbox_id AS toolboxId, toolbox.name AS toolboxName, drawer.name,
  COALESCE(drawer.label, drawer.name) AS label, drawer.row_number AS rowNumber, drawer.created_at AS createdAt
`;

// The device's box first, since that is the one the panel answers for. A drawer
// with no row goes last rather than first, which is where SQLite puts NULLs -
// otherwise a drawer just added without one jumps to the top of the list.
const selectDrawers = database.query(`
  SELECT ${drawerFields}
  FROM drawers AS drawer
  JOIN toolboxes AS toolbox ON toolbox.id = drawer.toolbox_id
  ORDER BY toolbox.has_device DESC, toolbox.name ASC, drawer.row_number ASC NULLS LAST, label COLLATE NOCASE ASC
`);

const selectTools = database.query(`
  SELECT id, drawer_id AS drawerId, name, quantity, notes, created_at AS createdAt
  FROM tools
  ORDER BY name COLLATE NOCASE ASC
`);

const selectDrawerById = database.query(`
  SELECT ${drawerFields}
  FROM drawers AS drawer
  JOIN toolboxes AS toolbox ON toolbox.id = drawer.toolbox_id
  WHERE drawer.id = ?1
`);

// Only the camera looks drawers up by label, and the camera is on the device's
// box - so "1A" means that box's 1A, not whichever box happens to have one.
const selectDrawerByLabel = database.query(`
  SELECT ${drawerFields}
  FROM drawers AS drawer
  JOIN toolboxes AS toolbox ON toolbox.id = drawer.toolbox_id
  WHERE toolbox.has_device = 1 AND COALESCE(drawer.label, drawer.name) = ?1 COLLATE NOCASE
`);

const selectDrawersAboveRow = database.query(`
  SELECT name, row_number AS rowNumber
  FROM drawers
  WHERE toolbox_id = ?1 AND row_number > ?2
  ORDER BY row_number ASC
`);

const insertDrawer = database.query(`
  INSERT INTO drawers (toolbox_id, name, label, row_number)
  VALUES (?1, ?2, ?3, ?4)
`);

const updateDrawerFields = database.query(`
  UPDATE drawers SET name = ?2, label = ?3, row_number = ?4 WHERE id = ?1
`);

const selectToolboxes = database.query(`
  SELECT toolbox.id, toolbox.name, toolbox.row_count AS rowCount, toolbox.has_device AS hasDevice,
         toolbox.created_at AS createdAt, COUNT(drawer.id) AS drawerCount
  FROM toolboxes AS toolbox
  LEFT JOIN drawers AS drawer ON drawer.toolbox_id = toolbox.id
  GROUP BY toolbox.id
  ORDER BY toolbox.has_device DESC, toolbox.name ASC
`);

const selectToolboxById = database.query(`
  SELECT id, name, row_count AS rowCount, has_device AS hasDevice, created_at AS createdAt,
         (SELECT COUNT(*) FROM drawers WHERE toolbox_id = ?1) AS drawerCount
  FROM toolboxes
  WHERE id = ?1
`);

const selectDeviceToolboxId = database.query(`
  SELECT id FROM toolboxes WHERE has_device = 1
`);

const insertToolbox = database.query(`
  INSERT INTO toolboxes (name, row_count)
  VALUES (?1, ?2)
`);

const updateToolboxFields = database.query(`
  UPDATE toolboxes SET name = ?2, row_count = ?3 WHERE id = ?1
`);

const clearDeviceToolbox = database.query(`
  UPDATE toolboxes SET has_device = 0 WHERE has_device = 1
`);

const markDeviceToolbox = database.query(`
  UPDATE toolboxes SET has_device = 1 WHERE id = ?1
`);

const deleteToolboxById = database.query(`
  DELETE FROM toolboxes WHERE id = ?1
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
         drawer.toolbox_id AS toolboxId,
         toolbox.name AS toolboxName,
         toolbox.has_device AS onDevice,
         COALESCE(drawer.label, drawer.name) AS label,
         drawer.row_number AS rowNumber,
         COALESCE(observation.quantity, tool.quantity) AS quantity,
         observation.confidence AS confidence,
         observation.observed_at AS observedAt
  FROM drawers AS drawer
  JOIN toolboxes AS toolbox ON toolbox.id = drawer.toolbox_id
  LEFT JOIN tools AS tool
    ON tool.drawer_id = drawer.id AND tool.name = ?1 COLLATE NOCASE
  LEFT JOIN latest_observations AS observation
    ON observation.drawer_id = drawer.id AND observation.position = 1
  WHERE tool.id IS NOT NULL OR observation.drawer_id IS NOT NULL
  ORDER BY toolbox.has_device DESC, toolbox.name ASC, drawer.row_number ASC, label COLLATE NOCASE ASC
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

// Without a toolboxId the drawer goes into the device's box, which is where
// every drawer went before there was more than one.
export function createDrawer(name: string, location?: { label?: string; rowNumber?: number; toolboxId?: number }) {
  const normalizedName = normalizeName(name, "Drawer name");
  const label = (location?.label ?? normalizedName).trim() || normalizedName;
  const toolbox = requireToolbox(location?.toolboxId ?? getDeviceToolboxId());
  const rowNumber = normalizeRowNumber(location?.rowNumber, toolbox.rowCount);

  try {
    const result = insertDrawer.run(toolbox.id, normalizedName, label, rowNumber) as { lastInsertRowid: number | bigint };
    return selectDrawerById.get(Number(result.lastInsertRowid)) as Omit<DrawerRecord, "toolCount" | "tools">;
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      throw new Error("A drawer with that name already exists in this toolbox.");
    }

    throw error;
  }
}

export class DrawerNotFoundError extends Error {}

// Every field is optional and an omitted one keeps its value. An empty label
// falls back to the name, as it does on create; a null rowNumber takes the
// drawer off the matrix. Tools and observations hang off the drawer's id, so
// none of this moves them - but the camera matches on label, so relabelling
// changes which detections land here.
export function updateDrawer(drawerId: number, changes: { name?: string; label?: string; rowNumber?: number | null }) {
  const drawer = selectDrawerById.get(drawerId) as Omit<DrawerRecord, "toolCount" | "tools"> | null;

  if (!drawer) {
    throw new DrawerNotFoundError("Drawer not found.");
  }

  const name = changes.name === undefined ? drawer.name : normalizeName(changes.name, "Drawer name");
  const label = changes.label === undefined ? drawer.label : changes.label.trim() || name;
  const rowNumber = changes.rowNumber === undefined
    ? drawer.rowNumber
    : normalizeRowNumber(changes.rowNumber, requireToolbox(drawer.toolboxId).rowCount);

  try {
    updateDrawerFields.run(drawer.id, name, label, rowNumber);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      throw new Error("A drawer with that name already exists in this toolbox.");
    }

    throw error;
  }

  return selectDrawerById.get(drawer.id) as Omit<DrawerRecord, "toolCount" | "tools">;
}

export class ToolboxNotFoundError extends Error {}

function toToolboxRecord(row: Omit<ToolboxRecord, "hasDevice"> & { hasDevice: number }): ToolboxRecord {
  return { ...row, hasDevice: row.hasDevice === 1 };
}

export function listToolboxes(): ToolboxRecord[] {
  return (selectToolboxes.all() as Array<Omit<ToolboxRecord, "hasDevice"> & { hasDevice: number }>).map(toToolboxRecord);
}

export function getToolbox(toolboxId: number): ToolboxRecord | null {
  const row = selectToolboxById.get(toolboxId) as (Omit<ToolboxRecord, "hasDevice"> & { hasDevice: number }) | null;
  return row ? toToolboxRecord(row) : null;
}

function requireToolbox(toolboxId: number) {
  const toolbox = Number.isInteger(toolboxId) ? getToolbox(toolboxId) : null;

  if (!toolbox) {
    throw new ToolboxNotFoundError("Toolbox not found.");
  }

  return toolbox;
}

// Throws only if the device's box has been unmarked some way the API refuses -
// updateToolbox and deleteToolbox both keep exactly one box carrying it.
export function getDeviceToolboxId(): number {
  const row = selectDeviceToolboxId.get() as { id: number } | null;

  if (!row) {
    throw new ToolboxNotFoundError("No toolbox is marked as holding the device.");
  }

  return row.id;
}

function normalizeRowCount(rowCount: number) {
  if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > MAX_TOOLBOX_ROWS) {
    throw new Error(`Toolbox rows must be a whole number between 1 and ${MAX_TOOLBOX_ROWS}.`);
  }

  return rowCount;
}

// A generous ceiling, only there so a typo cannot create ten thousand drawers.
export const MAX_DRAWERS_PER_TOOLBOX = 50;

// Creates the box and its drawers in one transaction, so a failure part way
// never leaves a half-built toolbox behind. Drawers are named "Drawer 1" to
// "Drawer N", labelled "1" to "N", and given rows 1 to N for as many as the box
// has rows - the rest are left without one. That is a starting point to rename
// and relabel, not a claim about the physical layout: the real box shares row 1
// between 1A, 1B and 1C, which no count could have guessed.
export function createToolbox(name: string, layout: { drawerCount: number; rowCount?: number }) {
  const normalizedName = normalizeName(name, "Toolbox name");
  const drawerCount = layout.drawerCount;

  if (!Number.isInteger(drawerCount) || drawerCount < 0 || drawerCount > MAX_DRAWERS_PER_TOOLBOX) {
    throw new Error(`Drawer count must be a whole number between 0 and ${MAX_DRAWERS_PER_TOOLBOX}.`);
  }

  const rowCount = normalizeRowCount(layout.rowCount ?? Math.min(Math.max(drawerCount, 1), MAX_TOOLBOX_ROWS));

  const build = database.transaction(() => {
    const result = insertToolbox.run(normalizedName, rowCount) as { lastInsertRowid: number | bigint };
    const toolboxId = Number(result.lastInsertRowid);

    for (let number = 1; number <= drawerCount; number++) {
      insertDrawer.run(toolboxId, `Drawer ${number}`, String(number), number <= rowCount ? number : null);
    }

    return toolboxId;
  });

  try {
    return getToolbox(build()) as ToolboxRecord;
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      throw new Error("A toolbox with that name already exists.");
    }

    throw error;
  }
}

// Every field is optional. hasDevice can only be set, never cleared: the device
// is always on some box, so the way to move it off this one is to mark another.
export function updateToolbox(toolboxId: number, changes: { name?: string; rowCount?: number; hasDevice?: boolean }) {
  const toolbox = requireToolbox(toolboxId);
  const name = changes.name === undefined ? toolbox.name : normalizeName(changes.name, "Toolbox name");
  const rowCount = changes.rowCount === undefined ? toolbox.rowCount : normalizeRowCount(changes.rowCount);

  if (changes.hasDevice === false && toolbox.hasDevice) {
    throw new Error("The device has to be on some toolbox. Mark another toolbox as holding it instead.");
  }

  // Shrinking past a drawer that is already using a high row would strand it:
  // the row would stay in the database and simply stop being indicatable. Refuse
  // and name the drawers, rather than silently orphaning them.
  const stranded = selectDrawersAboveRow.all(toolbox.id, rowCount) as Array<{ name: string; rowNumber: number }>;

  if (stranded.length > 0) {
    const named = stranded.map((drawer) => `${drawer.name} (row ${drawer.rowNumber})`).join(", ");
    throw new Error(`Cannot reduce to ${rowCount} rows while these drawers use a higher row: ${named}.`);
  }

  const save = database.transaction(() => {
    updateToolboxFields.run(toolbox.id, name, rowCount);

    if (changes.hasDevice === true && !toolbox.hasDevice) {
      clearDeviceToolbox.run();
      markDeviceToolbox.run(toolbox.id);
    }
  });

  try {
    save();
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      throw new Error("A toolbox with that name already exists.");
    }

    throw error;
  }

  return getToolbox(toolbox.id) as ToolboxRecord;
}

// Cascades like deleteDrawer, one level further out: every drawer in the box,
// their tools, and their observation history. The device's box is refused, so
// there is always a box for the panel to answer for.
export function deleteToolbox(toolboxId: number) {
  const toolbox = getToolbox(toolboxId);

  if (!toolbox) {
    return false;
  }

  if (toolbox.hasDevice) {
    throw new Error("This toolbox holds the device. Mark another toolbox as holding it before deleting this one.");
  }

  return deleteToolboxById.run(toolbox.id).changes > 0;
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

// A drawer's row has to be one its toolbox has. The count is the box's own, read
// by the caller at call time, so changing it takes effect without a restart.
function normalizeRowNumber(rowNumber: number | undefined | null, rowCount: number) {
  if (rowNumber === undefined || rowNumber === null) {
    return null;
  }

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
// 1. A drawer in the device's box beats one anywhere else. The tool within
//    reach is the useful answer, and it is the only one the panel can light.
// 2. A drawer with a row number beats one without. The device indicates a row
//    and nothing else, so a location it cannot show is useless as the primary.
// 3. Then the highest confidence, matching how `rows` already collapses. A null
//    confidence means the camera has never seen the tool there, so it sorts
//    last rather than counting as certainty.
// 4. Then lowest row number, then lowest drawer id, purely so the answer is
//    stable rather than dependent on SQLite's row order.
function pickPrimaryLocation(locations: ToolLocation[]): ToolLocation | null {
  if (locations.length === 0) {
    return null;
  }

  return [...locations].sort((a, b) => {
    if (a.onDevice !== b.onDevice) {
      return a.onDevice ? -1 : 1;
    }

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
  "s",
]);

// Carrier words that are also parts of real tool names: "box wrench", "box
// cutter", "tool steel". Stripping these along with the rest threw away the one
// word that identified the tool - "box wrench" reduced to "wrench", matched
// every wrench in the box, and returned whichever name was shortest. They are
// dropped only on a second pass, after a reading that keeps them has been tried
// and failed, so "box wrench" resolves exactly and "which drawer is the hammer
// in" still resolves at all.
const SOFT_CARRIER_WORDS = new Set(["drawer", "tool", "box", "toolbox"]);

// Words too common across a toolbox to identify anything on their own. A partial
// match needs at least one token that is *not* in here, or "screwdriver" would
// confidently pick one of three screwdrivers - see resolveToolQuery.
//
// Singular only: tokens go through singular() before this set is consulted, so
// the plural entries this once carried - "pliers", "bits", "keys", "cutters" -
// were words it could never be asked about.
const GENERIC_WORDS = new Set([
  "screwdriver", "wrench", "plier", "hammer", "saw", "drill", "bit", "key",
  "set", "socket", "driver", "cutter", "tape",
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

// Tool names are always tokenized with the default: a stored "Box Wrench" has to
// keep its "box", or nothing could ever match it on that word.
function meaningfulTokens(value: string, dropSoftCarriers = false) {
  return normalizeForMatching(value)
    .split(" ")
    .filter((token) => token.length > 0 && !CARRIER_WORDS.has(token))
    .filter((token) => !dropSoftCarriers || !SOFT_CARRIER_WORDS.has(token))
    .map(singular);
}

const selectAllToolNames = database.query(`
  SELECT name FROM tools
  UNION
  SELECT tool_name AS name FROM drawer_observations WHERE superseded_at IS NULL
`);

type CatalogueEntry = { name: string; tokens: Set<string> };

// Tier 2: every query token appears in the tool name. "needle nose pliers"
// matches "Needle-nose Pliers". Shortest name wins a tie, because it is the one
// with the least unmatched left over - the most specific fit.
function matchEveryToken(catalogue: CatalogueEntry[], queryTokens: string[]): ToolQueryMatch | null {
  const hits = catalogue
    .filter((entry) => queryTokens.every((token) => entry.tokens.has(token)))
    .map((entry) => entry.name)
    .sort((left, right) => left.length - right.length);

  if (hits.length === 0) {
    return null;
  }

  return { toolName: hits[0], matchType: "tokens", alternatives: hits.slice(1) };
}

// Tier 3: best token overlap, but only on the strength of a distinctive word.
// Without that rule "screwdriver" silently picks one of three screwdrivers; with
// it, all three come back as alternatives and the matrix lights every row they
// are in, which the rows array already supports.
function matchBestOverlap(catalogue: CatalogueEntry[], queryTokens: string[]): ToolQueryMatch | null {
  const scored = catalogue
    .map((entry) => {
      const shared = queryTokens.filter((token) => entry.tokens.has(token));
      const distinctive = shared.some((token) => !GENERIC_WORDS.has(token));
      return { name: entry.name, score: distinctive ? shared.length : 0 };
    })
    .filter((entry) => entry.score > 0);

  if (scored.length === 0) {
    return null;
  }

  const best = scored.reduce((highest, entry) => Math.max(highest, entry.score), 0);
  const winners = scored
    .filter((entry) => entry.score === best)
    .map((entry) => entry.name)
    .sort((left, right) => left.length - right.length);

  return { toolName: winners[0], matchType: "partial", alternatives: winners.slice(1) };
}

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

  // Soft carriers are kept here and dropped in the second pass below.
  const queryTokens = meaningfulTokens(trimmed);
  if (queryTokens.length === 0) {
    return null; // Carrier words only - "where is the" names no tool.
  }

  // Tokenized once. Both tiers and both passes read this same array; the shape
  // this replaces called meaningfulTokens on every name in tier 2 and again in
  // tier 3, so any query that fell through tokenized the whole catalogue twice.
  const catalogue: CatalogueEntry[] = (selectAllToolNames.all() as Array<{ name: string }>).map(
    (row) => ({ name: row.name, tokens: new Set(meaningfulTokens(row.name)) }),
  );

  // Two readings of the same query. The first keeps the soft carrier words, so
  // "box wrench" is tried as the tool it names before it is tried as "wrench";
  // the second drops them, so "which drawer is the hammer in" still resolves.
  const withoutSoftCarriers = meaningfulTokens(trimmed, true);
  const readings =
    withoutSoftCarriers.length > 0 && withoutSoftCarriers.length < queryTokens.length
      ? [queryTokens, withoutSoftCarriers]
      : [queryTokens];

  // Tier 2 across both readings before tier 3 across either: a full token match
  // on one reading beats a partial match on the other, or "box wrench" would
  // come back as whatever else in the box happens to have "box" in its name.
  for (const tokens of readings) {
    const hit = matchEveryToken(catalogue, tokens);
    if (hit) {
      return hit;
    }
  }

  for (const tokens of readings) {
    const hit = matchBestOverlap(catalogue, tokens);
    if (hit) {
      return hit;
    }
  }

  return null;
}

// Everywhere one named tool lives. Lifted out of findToolLocations so that an
// ambiguous query gets the same treatment for every tool it matched, rather than
// full detail for the winner and a bare name for the rest.
function locateTool(tool: string): ToolMatch {
  const drawers = (selectToolLocations.all(tool) as Array<Omit<ToolLocation, "onDevice"> & { onDevice: number }>)
    .map((drawer) => ({ ...drawer, onDevice: drawer.onDevice === 1 }));
  const rowsByNumber = new Map<number, number | null>();

  for (const drawer of drawers) {
    // `rows` is what the panel lights, so only the device's box contributes. Row
    // 3 of another box is still in `drawers`, but lighting row 3 here would
    // point at the wrong toolbox.
    if (drawer.rowNumber == null || !drawer.onDevice) {
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