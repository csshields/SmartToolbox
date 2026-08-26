import { expect, test } from "bun:test";
import { SerialLineBuffer } from "./serialTransport";

test("buffers partial newline-delimited serial messages", () => {
  const buffer = new SerialLineBuffer();

  expect(buffer.push('{"id":"req-1"')).toEqual([]);
  expect(buffer.push(',"type":"request"}\n{"id":"req-2"}\n')).toEqual([
    '{"id":"req-1","type":"request"}',
    '{"id":"req-2"}',
  ]);
});