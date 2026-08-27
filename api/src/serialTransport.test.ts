import { expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
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

test("skips a null response but keeps processing the rest of the chunk", async () => {
  const pairs = [fakeStreamPair()];
  const handled: string[] = [];
  const written: string[] = [];

  const transport = startSerialTransport({
    devicePath: "/fake/device",
    handleLine: async (line) => {
      handled.push(line);
      return line.startsWith("{") ? ackResponse("id") : null;
    },
    serializeResponse: (response) => `${response.id}\n`,
    onResponseWritten: (response) => written.push(response.id ?? ""),
    onError: () => {},
    openStreams: () => pairs[0],
  });

  pairs[0].input.write('debug text\n{"id":"req-1"}\nmore debug\n');
  await wait(10);

  expect(handled).toEqual(["debug text", '{"id":"req-1"}', "more debug"]);
  expect(written).toEqual(["id"]);

  transport.close();
});

// A device that is readable but not writable is a real failure mode, not a
// theoretical one: on the Pi the read stream reopened after a replug while the
// write stream did not, so every reply was dropped while the log looked healthy.
test("reconnects when a response write fails", async () => {
  const first = {
    input: new PassThrough(),
    output: new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("EACCES: permission denied"));
      },
    }),
  };
  const second = fakeStreamPair();
  const openedPairs = [first, second];
  let openCalls = 0;
  const errors: string[] = [];

  const transport = startSerialTransport({
    devicePath: "/fake/device",
    handleLine: async () => ackResponse("id"),
    serializeResponse: () => "reply\n",
    onError: (message) => errors.push(message),
    openStreams: () => openedPairs[openCalls++]!,
    retryDelaysMs: [1, 1],
  });

  first.input.write('{"id":"req-1"}\n');
  await wait(30);

  expect(errors.some((message) => message.includes("EACCES"))).toBe(true);
  expect(openCalls).toBe(2);

  transport.close();
});

test("reconnects when a response write throws synchronously", async () => {
  const first = fakeStreamPair();
  first.output.write = () => {
    throw new Error("EACCES: permission denied");
  };
  const second = fakeStreamPair();
  const openedPairs = [first, second];
  let openCalls = 0;
  const errors: string[] = [];

  const transport = startSerialTransport({
    devicePath: "/fake/device",
    handleLine: async () => ackResponse("id"),
    serializeResponse: () => "reply\n",
    onError: (message) => errors.push(message),
    openStreams: () => openedPairs[openCalls++]!,
    retryDelaysMs: [1, 1],
  });

  first.input.write('{"id":"req-1"}\n');
  await wait(30);

  expect(errors.some((message) => message.includes("EACCES"))).toBe(true);
  expect(openCalls).toBe(2);

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
