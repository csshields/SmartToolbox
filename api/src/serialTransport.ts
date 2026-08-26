import { createReadStream, createWriteStream } from "node:fs";
import type { SerialResponse } from "./serialProtocol";

export class SerialLineBuffer {
  private remainder = "";

  push(chunk: Buffer | string) {
    this.remainder += chunk.toString();
    const lines = this.remainder.split(/\r?\n/);
    this.remainder = lines.pop() ?? "";
    return lines.filter((line) => line.trim());
  }
}

export function startSerialTransport(options: {
  devicePath: string;
  handleLine: (line: string) => Promise<SerialResponse>;
  serializeResponse: (response: SerialResponse) => string;
  onError: (message: string) => void;
}) {
  const input = createReadStream(options.devicePath);
  const output = createWriteStream(options.devicePath, { flags: "a" });
  const buffer = new SerialLineBuffer();

  input.on("data", async (chunk: Buffer) => {
    for (const line of buffer.push(chunk)) {
      const response = await options.handleLine(line);
      output.write(options.serializeResponse(response));
    }
  });

  input.on("error", (error) => options.onError(`Serial input error: ${error.message}`));
  output.on("error", (error) => options.onError(`Serial output error: ${error.message}`));

  return {
    close() {
      input.close();
      output.end();
    },
  };
}