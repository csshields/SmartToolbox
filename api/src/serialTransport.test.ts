import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { SerialLineBuffer, startSerialTransport } from "./serialTransport";
import type { SerialResponse } from "./serialProtocol";

test("buffers partial newline-delimited serial messages", () => {
  const buffer = new SerialLineBuffer();

  expect(buffer.push('{"id":"req-1"')).toEqual([]);
  expect(buffer.push(',"type":"request"}\n{"id":"req-2"}\n')).toEqual([
    '{"id":"req-1","type":"request"}',
    '{"id":"req-2"}',
  ]);
});

function fakeStreamPair() {
  return { input: new PassThrough(), output: new PassThrough() };
}

function ackResponse(id: string): SerialResponse {
  return { id, success: true, body: {} };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("reconnects after the input stream errors", async () => {
  const pairs = [fakeStreamPair(), fakeStreamPair()];
  let openCalls = 0;
  const handled: string[] = [];
  const disconnects: number[] = [];

  const transport = startSerialTransport({
    devicePath: "/fake/device",
    handleLine: async (line) => {
      handled.push(line);
      return ackResponse("id");
    },
    serializeResponse: () => "",
    onError: () => {},
    onDisconnect: (delay) => disconnects.push(delay),
    retryDelaysMs: [1, 1],
    openStreams: () => pairs[openCalls++],
  });

  pairs[0].input.destroy(new Error("unplugged"));
  await wait(20);

  expect(openCalls).toBe(2);
  expect(disconnects.length).toBe(1);

  pairs[1].input.write('{"id":"req-1","type":"request"}\n');
  await wait(10);

  expect(handled).toEqual(['{"id":"req-1","type":"request"}']);

  transport.close();
});

test("resets the line buffer across a reconnect", async () => {
  const pairs = [fakeStreamPair(), fakeStreamPair()];
  let openCalls = 0;
  const handled: string[] = [];

  const transport = startSerialTransport({
    devicePath: "/fake/device",
    handleLine: async (line) => {
      handled.push(line);
      return ackResponse("id");
    },
    serializeResponse: () => "",
    onError: () => {},
    retryDelaysMs: [1, 1],
    openStreams: () => pairs[openCalls++],
  });

  // Leave a partial (unterminated) line on the first connection, then drop it.
  pairs[0].input.write('{"id":"partial"');
  pairs[0].input.destroy(new Error("unplugged"));
  await wait(20);

  // If the buffer were not reset, this would be glued onto the leftover
  // partial from the old connection instead of starting fresh.
  pairs[1].input.write('"complete"}\n');
  await wait(10);

  expect(handled).toEqual(['"complete"}']);

  transport.close();
});

test("close() cancels a pending reconnect", async () => {
  const pairs = [fakeStreamPair(), fakeStreamPair()];
  let openCalls = 0;

  const transport = startSerialTransport({
    devicePath: "/fake/device",
    handleLine: async () => ackResponse("id"),
    serializeResponse: () => "",
    onError: () => {},
    retryDelaysMs: [20, 20],
    openStreams: () => pairs[openCalls++],
  });

  pairs[0].input.destroy(new Error("unplugged"));
  transport.close();

  await wait(40);

  expect(openCalls).toBe(1);
});
