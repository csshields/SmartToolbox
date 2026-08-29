import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import type { Readable, Writable } from "node:stream";
import type { SerialResponse } from "./serialProtocol";

// A voice/audio line is one base64 blob of raw PCM and is by far the largest
// thing on this wire: ten seconds of 16 kHz 16-bit mono is 320 KB, which base64
// inflates to about 427 KB. The cap is that plus room for the JSON around it.
//
// Without a cap, a device that resets mid-line - or any stream that stops
// producing newlines - grows this buffer until the process dies. Dropping the
// partial line instead costs one recording, and the retry for a recording is
// pressing the pad again.
export const MAX_SERIAL_LINE_BYTES = 600_000;

export class SerialLineBuffer {
  private remainder = "";

  push(chunk: Buffer | string) {
    this.remainder += chunk.toString();
    const lines = this.remainder.split(/\r?\n/);
    this.remainder = lines.pop() ?? "";

    if (this.remainder.length > MAX_SERIAL_LINE_BYTES) {
      this.remainder = "";
    }

    return lines.filter((line) => line.trim());
  }
}

// Grows to 5s and holds. Retries are unlimited - the XIAO always comes back
// eventually, and an idle retry at the 5s ceiling costs nothing.
const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 5000];

// The kernel hands out a freshly enumerated ttyACM in cooked mode with echo on.
// That is a terminal configuration, and it breaks a machine protocol two ways:
// every byte the device sends is echoed straight back into its own receive
// buffer, and onlcr rewrites outgoing newlines. Raw mode is the fix, and it has
// to be reapplied on every connect - the settings reset when the device
// re-enumerates on replug or reset.
function configureRawMode(devicePath: string) {
  const result = spawnSync("stty", ["-F", devicePath, "raw", "-echo"], { encoding: "utf8" });

  if (result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "unknown error").trim();
    console.warn(`[serial] could not set raw mode on ${devicePath}: ${detail}`);
  }
}

function openRealStreams(devicePath: string) {
  configureRawMode(devicePath);

  return {
    input: createReadStream(devicePath),
    output: createWriteStream(devicePath, { flags: "a" }),
  };
}

export function startSerialTransport(options: {
  devicePath: string;
  handleLine: (line: string) => Promise<SerialResponse | null>;
  serializeResponse: (response: SerialResponse) => string;
  onError: (message: string) => void;
  onResponseWritten?: (response: SerialResponse) => void;
  onConnect?: () => void;
  onDisconnect?: (retryDelayMs: number) => void;
  openStreams?: (devicePath: string) => { input: Readable; output: Writable };
  retryDelaysMs?: number[];
}) {
  const openStreams = options.openStreams ?? openRealStreams;
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  let stopped = false;
  // Bumped on every teardown so stale events from a torn-down connection
  // (a late 'close', a handleLine that resolves after we've moved on) get ignored.
  let generation = 0;
  let retryAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let currentInput: Readable | null = null;
  let currentOutput: Writable | null = null;

  function nextRetryDelay() {
    const delay = retryDelays[Math.min(retryAttempt, retryDelays.length - 1)];
    retryAttempt++;
    return delay;
  }

  function teardown(input: Readable | null, output: Writable | null) {
    // A queued 'error' emission with no listener is fatal in Node, so swap in
    // a no-op before removing the real listeners rather than leaving a gap.
    input?.removeAllListeners();
    input?.on("error", () => {});
    output?.removeAllListeners();
    output?.on("error", () => {});
    input?.destroy();
    output?.destroy();
  }

  function scheduleReconnect(myGeneration: number) {
    if (stopped || myGeneration !== generation) {
      return;
    }

    generation++;
    teardown(currentInput, currentOutput);
    currentInput = null;
    currentOutput = null;

    const delay = nextRetryDelay();
    options.onDisconnect?.(delay);
    reconnectTimer = setTimeout(() => connect(), delay);
  }

  function connect() {
    if (stopped) {
      return;
    }

    const myGeneration = generation;
    const buffer = new SerialLineBuffer();

    let streams: { input: Readable; output: Writable };
    try {
      streams = openStreams(options.devicePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onError(`Serial open error: ${message}`);
      scheduleReconnect(myGeneration);
      return;
    }

    const { input, output } = streams;
    currentInput = input;
    currentOutput = output;
    let receivedData = false;

    input.on("data", async (chunk: Buffer) => {
      if (myGeneration !== generation) {
        return;
      }

      if (!receivedData) {
        receivedData = true;
        retryAttempt = 0;
        options.onConnect?.();
      }

      for (const line of buffer.push(chunk)) {
        const response = await options.handleLine(line);

        if (myGeneration !== generation) {
          // Connection was torn down mid-await - abandon the rest of this chunk too.
          return;
        }

        if (response === null) {
          continue; // Not a request (debug chatter) - nothing to reply to.
        }

        // A failed write means the device is gone or the write half was never
        // usable - reconnect rather than log. Without this the transport sits
        // half-open: the read side keeps delivering requests and every reply is
        // dropped, which looks healthy in the log but answers nothing.
        try {
          output.write(options.serializeResponse(response), (error) => {
            if (error) {
              options.onError(`Serial output error: ${error.message}`);
              scheduleReconnect(myGeneration);
              return;
            }

            options.onResponseWritten?.(response);
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          options.onError(`Serial output error: ${message}`);
          scheduleReconnect(myGeneration);
          return;
        }
      }
    });

    input.on("error", (error) => {
      options.onError(`Serial input error: ${error.message}`);
      scheduleReconnect(myGeneration);
    });
    input.on("close", () => scheduleReconnect(myGeneration));

    output.on("error", (error) => {
      options.onError(`Serial output error: ${error.message}`);
      scheduleReconnect(myGeneration);
    });
  }

  connect();

  return {
    close() {
      stopped = true;
      generation++;

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      teardown(currentInput, currentOutput);
      currentInput = null;
      currentOutput = null;
    },
  };
}
