import { serve } from "bun";
import { join } from "node:path";
import { addToolToDrawer, assignToolToDrawer, createDrawer, findDrawerByLabel, findToolDrawer, findToolLocations, getTranscriptionSettings, listDrawers, listRequestLogs, recordDrawerObservation, recordRequestLog, saveTranscriptionSettings } from "./db";
import { parseSerialRequest, serialError, serialSuccess, serializeSerialResponse, type SerialRequest, type SerialResponse } from "./serialProtocol";
import { startSerialTransport } from "./serialTransport";

const port = Number(Bun.env.PORT ?? 3000);

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

  recordRequestLog(log);
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
      return serialSuccess(request.id, {
        acknowledged: true,
        firmwareVersion: typeof body.firmwareVersion === "string" ? body.firmwareVersion : null,
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

    for (const detection of body.detections) {
      recordDrawerObservation({
        drawerId: drawer.id,
        toolName: typeof detection.label === "string" ? detection.label : "",
        confidence: Number(detection.confidence),
        quantity: typeof detection.quantity === "number" ? detection.quantity : undefined,
        modelVersion: typeof body.modelVersion === "string" ? body.modelVersion : undefined,
      });
    }

    return serialSuccess(request.id, { recorded: body.detections.length, drawerLabel: drawer.label });
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
    console.log(`[serial-debug] ${line}`);
    return null;
  }

  try {
    const request = parseSerialRequest(line);
    console.log(`[serial] request id=${request.id} endpoint=${request.endpoint}`);
    return await handleSerialRequest(request);
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

    if (pathname === '/api/logs' && req.method === 'GET') {
      const requestedLimit = Number(url.searchParams.get('limit') ?? '50');
      return jsonResponse({ logs: listRequestLogs(requestedLimit) });
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

        for (const detection of body.detections) {
          recordDrawerObservation({
            drawerId: validatedDrawerId,
            toolName: detection.label ?? '',
            quantity: detection.quantity,
            confidence: Number(detection.confidence),
            modelVersion: body.modelVersion,
          });
        }

        writeRequestLog({
          method: req.method,
          path: pathname,
          drawerNumber: validatedDrawerId,
          statusCode: 201,
          result: 'Vision observations recorded',
          details: `${body.detections.length} detection(s)`,
        });
        return jsonResponse({ success: true, recorded: body.detections.length }, { status: 201 });
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

    if (pathname === '/api/tools/assign' && req.method === 'POST') {
      let body: { tool?: string; drawerNumber?: number; quantity?: number; notes?: string } | null = null;

      try {
        body = await readJsonBody(req) as { tool?: string; drawerNumber?: number; quantity?: number; notes?: string };
        const assignedTool = assignToolToDrawer(Number(body.drawerNumber), {
          name: body.tool ?? '',
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
          tool: assignedTool.name,
          drawerNumber: assignedTool.drawerId,
        }, { status: 201 });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to assign tool.';
        const status = message === 'Drawer not found.' ? 404 : 400;
        writeRequestLog({
          method: req.method,
          path: pathname,
          tool: body?.tool,
          drawerNumber: body?.drawerNumber ?? null,
          statusCode: status,
          result: 'Tool assignment failed',
          details: message,
        });
        return errorResponse(message, status);
      }
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

const serialDevice = Bun.env.SERIAL_DEVICE ?? (process.platform === "linux" ? "/dev/ttyACM0" : undefined);

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
