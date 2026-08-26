export type SerialEndpoint = "device/status" | "tools/lookup" | "vision/observe";

export type SerialRequest = {
  id: string;
  type: "request";
  endpoint: SerialEndpoint;
  body: unknown;
};

export type SerialSuccessResponse = {
  id: string;
  success: true;
  body: unknown;
};

export type SerialErrorResponse = {
  id: string | null;
  success: false;
  error: {
    code: string;
    message: string;
  };
};

export type SerialResponse = SerialSuccessResponse | SerialErrorResponse;

type SerialRequestHandler = (request: SerialRequest) => SerialResponse | Promise<SerialResponse>;

const serialEndpoints = new Set<SerialEndpoint>([
  "device/status",
  "tools/lookup",
  "vision/observe",
]);

export function parseSerialRequest(line: string): SerialRequest {
  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Message must be valid JSON.");
  }

  if (!value || typeof value !== "object") {
    throw new Error("Message must be a JSON object.");
  }

  const message = value as Record<string, unknown>;

  if (typeof message.id !== "string" || !message.id.trim()) {
    throw new Error("Message id is required.");
  }

  if (message.type !== "request") {
    throw new Error("Message type must be request.");
  }

  if (typeof message.endpoint !== "string" || !serialEndpoints.has(message.endpoint as SerialEndpoint)) {
    throw new Error("Message endpoint is not supported.");
  }

  if (!Object.hasOwn(message, "body")) {
    throw new Error("Message body is required.");
  }

  return {
    id: message.id,
    type: "request",
    endpoint: message.endpoint as SerialEndpoint,
    body: message.body,
  };
}

export function serialSuccess(id: string, body: unknown): SerialSuccessResponse {
  return { id, success: true, body };
}

export function serialError(id: string | null, code: string, message: string): SerialErrorResponse {
  return { id, success: false, error: { code, message } };
}

export function serializeSerialResponse(response: SerialResponse) {
  return `${JSON.stringify(response)}\n`;
}

export async function dispatchSerialRequest(
  request: SerialRequest,
  handlers: Record<SerialEndpoint, SerialRequestHandler>,
) {
  return handlers[request.endpoint](request);
}