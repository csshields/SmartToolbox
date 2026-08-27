import { createReadStream, createWriteStream } from "node:fs";
import type { Readable, Writable } from "node:stream";
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

// Backoff schedule for reconnect attempts: grows to 5s and then holds there.
// Retries are unlimited by design - the XIAO is local hardware that is always
// expected to come back (unplug, reset, reflash), never a remote service that
// might be down for good. At the 5s ceiling, an idle retry loop costs one
// failed open per 5 seconds, so there is no reason to ever stop trying.
const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 5000];

function openRealStreams(devicePath: string) {
  return {
    input: createReadStream(devicePath),
    output: createWriteStream(devicePath, { flags: "a" }),
  };
}

export function startSerialTransport(options: {
  devicePath: string;
  handleLine: (line: string) => Promise<SerialResponse>;
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
  // Bumped on every teardown so events from a torn-down connection (a 'close'
  // that fires after 'error' already triggered a reconnect, or a handleLine
  // that resolves after we've already moved on) are recognized as stale and
  // ignored, instead of triggering a second, redundant reconnect cycle.
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
    // A stream can have an 'error' emission already queued (e.g. someone else
    // called destroy(err) on it) at the moment we decide to stop caring about
    // it. Node treats an 'error' event with no listener as fatal, so swap in a
    // no-op before removing the real listeners rather than leaving a gap.
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
          return;
        }

        output.write(options.serializeResponse(response), (error) => {
          if (error) {
            options.onError(`Serial output error: ${error.message}`);
            return;
          }

          options.onResponseWritten?.(response);
        });
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
