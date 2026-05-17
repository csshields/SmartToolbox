import { serve } from "bun";
import { join } from "node:path";
import { addToolToDrawer, assignToolToDrawer, createDrawer, findToolDrawer, listDrawers, listRequestLogs, recordRequestLog } from "./db";

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
        const body = await readJsonBody(req) as { name?: string };
        const drawer = createDrawer(body.name ?? '');
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
