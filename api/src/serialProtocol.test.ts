import { expect, test } from "bun:test";
import {
  dispatchSerialRequest,
  parseSerialRequest,
  serialError,
  serialSuccess,
  serializeSerialResponse,
} from "./serialProtocol";

test("parses a tool lookup request", () => {
  expect(parseSerialRequest('{"id":"req-001","type":"request","endpoint":"tools/lookup","body":{"query":"needle nose pliers"}}')).toEqual({
    id: "req-001",
    type: "request",
    endpoint: "tools/lookup",
    body: { query: "needle nose pliers" },
  });
});

test("rejects a request without a supported endpoint", () => {
  expect(() => parseSerialRequest('{"id":"req-001","type":"request","endpoint":"audio/upload","body":{}}')).toThrow("Message endpoint is not supported.");
});

test("dispatches each initial request type", async () => {
  const request = parseSerialRequest('{"id":"req-002","type":"request","endpoint":"device/status","body":{"firmwareVersion":"0.1.0"}}');
  const response = await dispatchSerialRequest(request, {
    "device/status": (message) => serialSuccess(message.id, { acknowledged: true }),
    "tools/lookup": (message) => serialSuccess(message.id, { found: false }),
    "vision/observe": (message) => serialError(message.id, "NOT_IMPLEMENTED", "Vision observations are not enabled."),
  });

  expect(serializeSerialResponse(response)).toBe('{"id":"req-002","success":true,"body":{"acknowledged":true}}\n');
});