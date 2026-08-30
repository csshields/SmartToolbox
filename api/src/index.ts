import { serve } from "bun";
import { join } from "node:path";
import { pcmToWav, parseVoiceAudioBody, transcribeAudio } from "./voice";
import { collectDeviceCommand, DEVICE_COMMANDS, isDeviceCommand, peekDeviceCommand, queueDeviceCommand } from "./deviceCommands";
import { addToolToDrawer, assignToolToDrawer, createDrawer, deleteDrawer, deleteTool, findDrawerByLabel, findToolDrawer, findToolLocations, getDeviceStatus, getToolboxRowCount, getTranscriptionSettings, MAX_TOOLBOX_ROWS, listDrawers, listRequestLogs, recordDeviceContact, recordDrawerObservations, recordRequestLog, saveToolboxRowCount, saveTranscriptionSettings, ToolNameConflictError } from "./db";
import { parseSerialRequest, serialError, serialSuccess, serializeSerialResponse, type SerialRequest, type SerialResponse } from "./serialProtocol";
import { startSerialTransport } from "./serialTransport";
import { FIRMWARE_DIR, findLatestFirmware, isUpdateAvailable } from "./firmware";

const port = Number(Bun.env.PORT ?? 3000);

// Declared up here because /api/devices reports whether the listener is even
// running: on Windows it is not, and a device that has never been seen there
// means "no serial listener", not "no device".
const serialDevice = Bun.env.SERIAL_DEVICE ?? (process.platform === "linux" ? "/dev/ttyACM0" : undefined);

function jsonResponse(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ error: message }, { status });
}

function writeRequestLog(log: {
  method: string;
  path: string;
  tool?: string;
  drawerNumber?: number | null;
  statusCode: number;
  result: string;
  details?: string;
}) {
  if (log.path === "/api/logs") {
    return;
  }

  // Best effort, deliberately. Several routes log inside the same try block that
  // performed the mutation, so a throw here used to turn a completed write into
  // a 400 - inviting the client to retry something that had already happened.
  // This log is diagnostics; it does not get to change an API result.
  try {
    recordRequestLog(log);
  } catch (error) {
    console.error(`[api] request log write failed: ${error instanceof Error ? error.message : error}`);
  }

  console.log(
    `[api] ${log.method} ${log.path} status=${log.statusCode} result=${log.result}` +
      `${log.tool ? ` tool=${log.tool}` : ""}` +
      `${log.drawerNumber != null ? ` drawer=${log.drawerNumber}` : ""}`,
  );
}

async function readJsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function validateNasUrl(value: string) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("NAS Whisper URL must be a valid HTTP or HTTPS URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("NAS Whisper URL must use HTTP or HTTPS.");
  }

  return url.toString().replace(/\/$/, "");
}

function transcriptionSettingsResponse() {
  return {
    ...getTranscriptionSettings(),
    openaiApiKeyConfigured: Boolean(Bun.env.OPENAI_API_KEY),
  };
}

async function testTranscriptionProvider(provider: "nas_whisper" | "openai", nasUrl: string) {
  if (provider === "nas_whisper") {
    const response = await fetch(`${validateNasUrl(nasUrl)}/docs`, {
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      throw new Error(`NAS Whisper returned HTTP ${response.status}.`);
    }

    return { message: "NAS Whisper is reachable." };
  }

  if (!Bun.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured on this server.");
  }

  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${Bun.env.OPENAI_API_KEY}` },
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(`OpenAI returned HTTP ${response.status}.`);
  }

  return { message: "OpenAI API credentials are valid." };
}

async function handleSerialRequest(request: SerialRequest): Promise<SerialResponse> {
  try {
    if (request.endpoint === "device/status") {
      const body = request.body as { firmwareVersion?: unknown };

      // The one place the Pi gets to say something the device did not ask for.
      // Collected here rather than merely read, so it is delivered once - see
      // collectDeviceCommand for why re-delivery would be worse than a miss.
      const command = collectDeviceCommand();
      if (command) {
        console.log(`[command] delivered ${command} to the device`);
      }

      return serialSuccess(request.id, {
        acknowledged: true,
        firmwareVersion: typeof body.firmwareVersion === "string" ? body.firmwareVersion : null,
        ...(command ? { command } : {}),
      });
    }

    if (request.endpoint === "voice/audio") {
      const audio = parseVoiceAudioBody(request.body);
      const settings = getTranscriptionSettings();
      const startedAt = Date.now();

      const { transcript, provider } = await transcribeAudio(
        pcmToWav(audio.pcm, audio.sampleRate, audio.channels),
        settings,
      );

      // Logged here rather than left to the request log, because the request log
      // deliberately never sees the audio and this is the only place the two
      // numbers that matter - how long the clip was, how long the transcription
      // took - exist together.
      console.log(
        `[voice] ${audio.durationMs}ms audio -> ${provider} in ${Date.now() - startedAt}ms: ${JSON.stringify(transcript)}`,
      );

      // One round trip. The Pi is already holding the transcript, so resolving it
      // here saves the device a second request and a second wait - and the wait is
      // the expensive part of this feature.
      //
      // The body is deliberately the existing tools/lookup body with transcript
      // added, so the firmware reuses its found / not-found / error branches
      // rather than growing a parallel set that can drift out of step.
      const lookup = transcript ? findToolLocations(transcript) : null;

      if (lookup) {
        console.log(`[voice] "${transcript}" -> ${lookup.tool} (${lookup.matchType})`);
      }

      return serialSuccess(request.id, {
        transcript,
        provider,
        durationMs: audio.durationMs,
        // An empty transcript is silence, not a failed lookup. Both come back as
        // found:false, and the transcript is what tells them apart.
        ...(lookup ? { found: true, ...lookup } : { found: false }),
      });
    }

    if (request.endpoint === "tools/lookup") {
      const body = request.body as { query?: unknown };
      if (typeof body.query !== "string") {
        return serialError(request.id, "INVALID_REQUEST", "query is required");
      }

      const lookup = findToolLocations(body.query);
      return serialSuccess(request.id, lookup ? { found: true, ...lookup } : { found: false, message: "Tool not found." });
    }

    const body = request.body as {
      drawerLabel?: unknown;
      modelVersion?: unknown;
      detections?: Array<{ label?: unknown; confidence?: unknown; quantity?: unknown }>;
    };
    if (typeof body.drawerLabel !== "string") {
      return serialError(request.id, "INVALID_REQUEST", "drawerLabel is required");
    }
    if (!Array.isArray(body.detections) || body.detections.length === 0) {
      return serialError(request.id, "INVALID_REQUEST", "detections is required");
    }

    const drawer = findDrawerByLabel(body.drawerLabel);
    if (!drawer) {
      return serialError(request.id, "DRAWER_NOT_FOUND", "drawer label was not found");
    }

    const recorded = recordDrawerObservations(body.detections.map((detection) => ({
      drawerId: drawer.id,
      toolName: typeof detection.label === "string" ? detection.label : "",
      confidence: Number(detection.confidence),
      quantity: typeof detection.quantity === "number" ? detection.quantity : undefined,
      modelVersion: typeof body.modelVersion === "string" ? body.modelVersion : undefined,
    })));

    return serialSuccess(request.id, { recorded, drawerLabel: drawer.label });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to process serial request.";
    return serialError(request.id, "INVALID_REQUEST", message);
  }
}

async function handleSerialLine(line: string): Promise<SerialResponse | null> {
  // The firmware also prints plain-text debug output on this wire; ignore
  // anything that isn't a JSON object instead of answering it with an error.
  if (!line.trim().startsWith("{")) {
    // Surfaced rather than dropped so the sketch's TOUCH_DEBUG output is readable
    // from the Pi's journal; set TOUCH_DEBUG to 0 in the sketch to quiet it.
    //
    // Truncated because this branch takes anything that is not JSON, and a
    // voice/audio line that arrives mangled - a device reset mid-send, a dropped
    // byte - lands here as ~427 KB of base64. One of those in service.log is
    // worse than useless: it buries every line around it, which are the ones
    // that say what went wrong.
    console.log(`[serial-debug] ${line.length > 300 ? `${line.slice(0, 300)}... (${line.length} chars)` : line}`);
    return null;
  }

  try {
    const request = parseSerialRequest(line);
    console.log(`[serial] request id=${request.id} endpoint=${request.endpoint}`);

    // Every serial line is the only evidence the device exists: it sends
    // device/status once at boot and is otherwise silent until someone uses it.
    // Recorded before handling, because a request we go on to reject is still
    // proof the XIAO is on the wire.
    const body = request.body as { firmwareVersion?: unknown; query?: unknown; uptimeMs?: unknown };
    recordDeviceContact({
      endpoint: request.endpoint,
      firmwareVersion: typeof body.firmwareVersion === "string" ? body.firmwareVersion : undefined,
      uptimeMs: typeof body.uptimeMs === "number" ? body.uptimeMs : undefined,
    });

    const response = await handleSerialRequest(request);

    // Serial traffic used to exist only in the journal, which left the device's
    // activity invisible to the dashboard. SERIAL/serial: keeps it sortable
    // apart from HTTP in the same table.
    //
    // device/status is excluded: at one heartbeat every 30 seconds it would add
    // ~2,880 rows a day and bury the requests a person actually wants to read.
    // The devices table already holds everything a heartbeat carries.
    if (request.endpoint !== "device/status") {
      // For voice the transcript is the query - it is what the user actually
      // said, and it is the one field that makes a voice row in the dashboard
      // worth reading. The audio itself is never written anywhere.
      const transcript = response.success
        ? (response.body as { transcript?: unknown }).transcript
        : undefined;

      writeRequestLog({
        method: "SERIAL",
        path: `serial:${request.endpoint}`,
        tool: typeof body.query === "string"
          ? body.query
          : (typeof transcript === "string" ? transcript : undefined),
        statusCode: response.success ? 200 : 400,
        result: response.success ? "Serial request handled" : "Serial request rejected",
        details: response.success ? "" : response.error.message,
      });
    }

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to parse serial request.";
    return serialError(null, "INVALID_REQUEST", message);
  }
}

async function serveStaticFile(pathname: string) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");

  if (relativePath.includes("..")) {
    return new Response("Invalid path", { status: 400 });
  }

  const file = Bun.file(join(process.cwd(), "public", relativePath));

  if (await file.exists()) {
    return new Response(file);
  }

  // Extensionless routes get the matching page, so the nav can link /drawers
  // rather than /drawers.html. Without this the fallback below would answer
  // every dashboard page with index.html.
  if (!relativePath.includes(".")) {
    const page = Bun.file(join(process.cwd(), "public", `${relativePath}.html`));

    if (await page.exists()) {
      return new Response(page);
    }
  }

  const fallback = Bun.file(join(process.cwd(), "public", "index.html"));

  if (await fallback.exists()) {
    return new Response(fallback, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  return new Response("404 Not Found", { status: 404 });
}

serve({
  port,
  async fetch(req: Request) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);

    // Handle API routes
    if (pathname === '/health') {
      return jsonResponse({ status: 'Ok' });
    }

    if (pathname === '/query' && req.method === 'POST') {
      const message = await req.json();
      console.log('Query:', message);
      return jsonResponse({ reply: 'Received' });
    }

    if (pathname === '/api/drawers' && req.method === 'GET') {
      const response = jsonResponse({ drawers: listDrawers() });
      writeRequestLog({
        method: req.method,
        path: pathname,
        statusCode: 200,
        result: 'Drawers listed',
      });
      return response;
    }

    if (pathname === '/api/drawers' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req) as { name?: string; label?: string; rowNumber?: number };
        const drawer = createDrawer(body.name ?? '', { label: body.label, rowNumber: body.rowNumber });
        const response = jsonResponse({ drawer }, { status: 201 });
        writeRequestLog({
          method: req.method,
          path: pathname,
          statusCode: 201,
          result: 'Drawer created',
          details: drawer.name,
        });
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to create drawer.';
        const status = message === 'A drawer with that name already exists.' ? 409 : 400;
        writeRequestLog({
          method: req.method,
          path: pathname,
          statusCode: status,
          result: 'Drawer create failed',
          details: message,
        });
        return errorResponse(message, status);
      }
    }

    if (pathname === '/api/devices' && req.method === 'GET') {
      const device = getDeviceStatus();
      const latest = findLatestFirmware(join(process.cwd(), FIRMWARE_DIR));

      const queued = peekDeviceCommand();

      return jsonResponse({
        device,
        // Whether the listener runs at all is the difference between "the XIAO
        // is unplugged" and "this is Windows, so nothing was ever listening".
        // The page cannot tell those apart without being told.
        serialDevice: serialDevice ?? null,
        pendingCommand: queued ? { command: queued.command, queuedAt: new Date(queued.queuedAt).toISOString() } : null,
        firmware: latest
          ? {
              latestVersion: latest.version,
              updateAvailable: device ? isUpdateAvailable(latest, device.firmwareVersion) : false,
            }
          : null,
      });
    }

    if (pathname === '/api/devices/command' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req) as { command?: unknown };

        if (!isDeviceCommand(body.command)) {
          throw new Error(`command must be one of: ${DEVICE_COMMANDS.join(', ')}`);
        }

        const queued = queueDeviceCommand(body.command);

        // Not "sent". The device collects this on its next heartbeat, and
        // saying otherwise would invite someone to treat a queue as a delivery.
        writeRequestLog({
          method: req.method,
          path: pathname,
          statusCode: 202,
          result: `Queued ${queued.command} for the device`,
        });

        return jsonResponse({
          queued: { command: queued.command, queuedAt: new Date(queued.queuedAt).toISOString() },
          message: 'Queued. The device collects it on its next heartbeat.',
        }, { status: 202 });
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : 'Unable to queue the command.');
      }
    }

    if (pathname === '/api/logs' && req.method === 'GET') {
      const requestedLimit = Number(url.searchParams.get('limit') ?? '50');
      return jsonResponse({ logs: listRequestLogs(requestedLimit) });
    }

    if (pathname === '/api/settings/toolbox' && req.method === 'GET') {
      return jsonResponse({
        settings: { rowCount: getToolboxRowCount(), maxRowCount: MAX_TOOLBOX_ROWS },
      });
    }

    if (pathname === '/api/settings/toolbox' && req.method === 'PUT') {
      try {
        const body = await readJsonBody(req) as { rowCount?: number };
        const rowCount = saveToolboxRowCount(Number(body.rowCount));

        writeRequestLog({
          method: req.method,
          path: pathname,
          statusCode: 200,
          result: 'Toolbox rows saved',
          details: String(rowCount),
        });
        return jsonResponse({ settings: { rowCount, maxRowCount: MAX_TOOLBOX_ROWS } });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to save toolbox rows.';
        writeRequestLog({
          method: req.method,
          path: pathname,
          statusCode: 400,
          result: 'Toolbox rows save failed',
          details: message,
        });
        return errorResponse(message);
      }
    }

    if (pathname === '/api/settings/transcription' && req.method === 'GET') {
      return jsonResponse({ settings: transcriptionSettingsResponse() });
    }

    if (pathname === '/api/settings/transcription' && req.method === 'PUT') {
      try {
        const body = await readJsonBody(req) as { provider?: string; nasUrl?: string };

        if (body.provider !== 'nas_whisper' && body.provider !== 'openai') {
          throw new Error('Transcription provider must be NAS Whisper or OpenAI.');
        }

        const settings = saveTranscriptionSettings({
          provider: body.provider,
          nasUrl: validateNasUrl(body.nasUrl ?? ''),
        });
        const response = jsonResponse({
          settings: {
            ...settings,
            openaiApiKeyConfigured: Boolean(Bun.env.OPENAI_API_KEY),
          },
        });
        writeRequestLog({
          method: req.method,
          path: pathname,
          statusCode: 200,
          result: 'Transcription settings saved',
          details: settings.provider,
        });
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to save transcription settings.';
        writeRequestLog({
          method: req.method,
          path: pathname,
          statusCode: 400,
          result: 'Transcription settings save failed',
          details: message,
        });
        return errorResponse(message);
      }
    }

    if (pathname === '/api/settings/transcription/test' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req) as { provider?: string; nasUrl?: string };

        if (body.provider !== 'nas_whisper' && body.provider !== 'openai') {
          throw new Error('Transcription provider must be NAS Whisper or OpenAI.');
        }

        const nasUrl = validateNasUrl(body.nasUrl ?? '');
        const result = await testTranscriptionProvider(body.provider, nasUrl);
        writeRequestLog({
          method: req.method,
          path: pathname,
          statusCode: 200,
          result: 'Transcription provider reachable',
          details: body.provider,
        });
        return jsonResponse({ success: true, ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to test transcription provider.';
        writeRequestLog({
          method: req.method,
          path: pathname,
          statusCode: 400,
          result: 'Transcription provider test failed',
          details: message,
        });
        return errorResponse(message);
      }
    }

    if (pathname === '/api/tools/find' && req.method === 'GET') {
      const toolName = url.searchParams.get('tool') ?? '';

      try {
        const toolLocation = findToolDrawer(toolName);

        if (!toolLocation) {
          writeRequestLog({
            method: req.method,
            path: pathname,
            tool: toolName,
            statusCode: 404,
            result: 'Tool not found',
          });
          return jsonResponse({ result: 'Tool not found' }, { status: 404 });
        }

        writeRequestLog({
          method: req.method,
          path: pathname,
          tool: toolLocation.tool,
          drawerNumber: toolLocation.drawerId,
          statusCode: 200,
          result: 'Tool found',
          details: toolLocation.drawerName,
        });
        return jsonResponse(toolLocation);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to find tool.';
        writeRequestLog({
          method: req.method,
          path: pathname,
          tool: toolName,
          statusCode: 400,
          result: 'Tool lookup failed',
          details: message,
        });
        return errorResponse(message, 400);
      }
    }

    if (pathname === '/api/tools/lookup' && req.method === 'GET') {
      const query = url.searchParams.get('query') ?? '';

      try {
        const lookup = findToolLocations(query);
        if (!lookup) {
          return jsonResponse({ found: false, message: 'Tool not found.' });
        }

        return jsonResponse({ found: true, ...lookup });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to look up tool.';
        return errorResponse(message);
      }
    }

    // Unlike every other endpoint here, this one can overwrite the device's
    // firmware, so the spec's "trusted home LAN, no auth" stance is not enough.
    // It fails closed: with no DEVICE_KEY configured it serves nothing at all.
    if (pathname === '/api/firmware/latest' && req.method === 'GET') {
      const expectedKey = Bun.env.DEVICE_KEY;

      if (!expectedKey) {
        console.warn('[firmware] DEVICE_KEY is not set - refusing to serve firmware');
        return jsonResponse({ error: 'Firmware updates are not configured.' }, { status: 503 });
      }

      if (req.headers.get('x-device-key') !== expectedKey) {
        writeRequestLog({
          method: req.method,
          path: pathname,
          statusCode: 401,
          result: 'Firmware update rejected',
          details: 'invalid device key',
        });
        return jsonResponse({ error: 'Invalid device key.' }, { status: 401 });
      }

      const currentVersion = url.searchParams.get('currentVersion') ?? '';
      const latest = findLatestFirmware(join(process.cwd(), FIRMWARE_DIR));

      if (!latest || !isUpdateAvailable(latest, currentVersion)) {
        return new Response(null, { status: 204 });
      }

      writeRequestLog({
        method: req.method,
        path: pathname,
        statusCode: 200,
        result: 'Firmware served',
        details: `${currentVersion || 'unknown'} -> ${latest.version}`,
      });

      return new Response(Bun.file(latest.path), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(latest.size),
          'X-Firmware-Version': latest.version,
        },
      });
    }

    if (pathname === '/api/vision/observations' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req) as {
          drawerId?: number;
          modelVersion?: string;
          detections?: Array<{ label?: string; confidence?: number; quantity?: number }>;
        };
        const drawerId = body.drawerId;

        if (typeof drawerId !== 'number' || !Number.isInteger(drawerId) || drawerId < 1) {
          throw new Error('Drawer id is required.');
        }
        const validatedDrawerId = drawerId;

        if (!Array.isArray(body.detections) || body.detections.length === 0) {
          throw new Error('At least one detection is required.');
        }

        const recorded = recordDrawerObservations(body.detections.map((detection) => ({
          drawerId: validatedDrawerId,
          toolName: detection.label ?? '',
          quantity: detection.quantity,
          confidence: Number(detection.confidence),
          modelVersion: body.modelVersion,
        })));

        writeRequestLog({
          method: req.method,
          path: pathname,
          drawerNumber: validatedDrawerId,
          statusCode: 201,
          result: 'Vision observations recorded',
          details: `${recorded} detection(s)`,
        });
        return jsonResponse({ success: true, recorded }, { status: 201 });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to record vision observations.';
        const status = message === 'Drawer not found.' ? 404 : 400;
        writeRequestLog({
          method: req.method,
          path: pathname,
          statusCode: status,
          result: 'Vision observations rejected',
          details: message,
        });
        return errorResponse(message, status);
      }
    }

    // Takes a toolId, not a tool name. A name is not unique across drawers, so
    // the old signature could only guess which row the caller meant.
    if (pathname === '/api/tools/assign' && req.method === 'POST') {
      let body: { toolId?: number; drawerNumber?: number; quantity?: number; notes?: string } | null = null;

      try {
        body = await readJsonBody(req) as { toolId?: number; drawerNumber?: number; quantity?: number; notes?: string };
        const assignedTool = assignToolToDrawer(Number(body.drawerNumber), {
          toolId: Number(body.toolId),
          quantity: body.quantity,
          notes: body.notes,
        });
        writeRequestLog({
          method: req.method,
          path: pathname,
          tool: assignedTool.name,
          drawerNumber: assignedTool.drawerId,
          statusCode: 201,
          result: 'Tool assigned',
          details: body.notes ?? '',
        });
        return jsonResponse({
          message: 'Tool assigned',
          toolId: assignedTool.id,
          tool: assignedTool.name,
          drawerNumber: assignedTool.drawerId,
        }, { status: 201 });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to assign tool.';
        const status = error instanceof ToolNameConflictError
          ? 409
          : message === 'Drawer not found.' || message === 'Tool not found.'
            ? 404
            : 400;
        writeRequestLog({
          method: req.method,
          path: pathname,
          drawerNumber: body?.drawerNumber ?? null,
          statusCode: status,
          result: 'Tool assignment failed',
          details: message,
        });
        return errorResponse(message, status);
      }
    }

    // Both patterns are fully anchored, so neither can match /api/drawers nor
    // each other's paths and the ordering here carries no meaning.
    const deleteToolMatch = pathname.match(/^\/api\/drawers\/(\d+)\/tools\/(\d+)$/);

    if (deleteToolMatch && req.method === 'DELETE') {
      const drawerId = Number(deleteToolMatch[1]);
      const toolId = Number(deleteToolMatch[2]);
      const removed = deleteTool(drawerId, toolId);

      writeRequestLog({
        method: req.method,
        path: pathname,
        drawerNumber: drawerId,
        statusCode: removed ? 200 : 404,
        result: removed ? 'Tool deleted' : 'Tool not found',
        details: `tool ${toolId}`,
      });

      return removed
        ? jsonResponse({ success: true })
        : jsonResponse({ error: 'Tool not found.' }, { status: 404 });
    }

    const deleteDrawerMatch = pathname.match(/^\/api\/drawers\/(\d+)$/);

    if (deleteDrawerMatch && req.method === 'DELETE') {
      const drawerId = Number(deleteDrawerMatch[1]);
      const removed = deleteDrawer(drawerId);

      writeRequestLog({
        method: req.method,
        path: pathname,
        drawerNumber: drawerId,
        statusCode: removed ? 200 : 404,
        result: removed ? 'Drawer deleted' : 'Drawer not found',
        details: removed ? 'tools and observations cascaded' : '',
      });

      return removed
        ? jsonResponse({ success: true })
        : jsonResponse({ error: 'Drawer not found.' }, { status: 404 });
    }

    const toolRouteMatch = pathname.match(/^\/api\/drawers\/(\d+)\/tools$/);

    if (toolRouteMatch && req.method === 'POST') {
      try {
        const drawerId = Number(toolRouteMatch[1]);
        const body = await readJsonBody(req) as { name?: string; quantity?: number; notes?: string };
        const tool = addToolToDrawer(drawerId, {
          name: body.name ?? '',
          quantity: body.quantity,
          notes: body.notes,
        });
        writeRequestLog({
          method: req.method,
          path: pathname,
          tool: tool.name,
          drawerNumber: drawerId,
          statusCode: 201,
          result: 'Tool saved',
          details: body.notes ?? '',
        });
        return jsonResponse({ tool }, { status: 201 });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to save tool.';
        const status = message === 'Drawer not found.' ? 404 : 400;
        writeRequestLog({
          method: req.method,
          path: pathname,
          drawerNumber: Number(toolRouteMatch[1]),
          statusCode: status,
          result: 'Tool save failed',
          details: message,
        });
        return errorResponse(message, status);
      }
    }

    if (pathname.startsWith('/api/')) {
      writeRequestLog({
        method: req.method,
        path: pathname,
        statusCode: 404,
        result: 'Route not found',
      });
      return errorResponse('Not found.', 404);
    }

    return serveStaticFile(pathname);
  },
});

console.log(`Server running on http://localhost:${port}`);

if (serialDevice) {
  startSerialTransport({
    devicePath: serialDevice,
    handleLine: handleSerialLine,
    serializeResponse: serializeSerialResponse,
    onError: (message) => console.error(`[serial] ${message}`),
    onResponseWritten: (response) => console.log(`[serial] response written id=${response.id}`),
    onConnect: () => console.log(`[serial] connected on ${serialDevice}`),
    onDisconnect: (retryDelayMs) => console.log(`[serial] disconnected, retrying in ${retryDelayMs}ms`),
  });
  console.log(`Serial service listening on ${serialDevice}`);
}
