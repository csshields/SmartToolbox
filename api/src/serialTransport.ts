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
//
// Counted in characters, not bytes - this compares String.length, which is
// UTF-16 code units. The wire is ASCII JSON and base64, so the two are the same
// number here, and the name now says which one is being measured.
export const MAX_SERIAL_LINE_CHARS = 600_000;

export class SerialLineBuffer {
  private remainder = "";
  // Set when a line blew past the cap, and held until the next newline. Clearing
  // the remainder alone was not enough: the rest of that same line kept
  // accumulating and came back as a complete line of its own - a base64 fragment
  // that reached the request handler and was logged as debug chatter. A line that
  // is dropped has to be dropped all the way to its newline.
  private discardingLine = false;

  push(chunk: Buffer | string) {
    this.remainder += chunk.toString();
    const lines = this.remainder.split(/\r?\n/);
    this.remainder = lines.pop() ?? "";

    if (this.discardingLine) {
      if (lines.length === 0) {
        this.remainder = ""; // Still inside the oversized line - keep discarding.
        return [];
      }

      // The first element is the tail of the line that blew the cap; only what
      // follows the newline after it is a line in its own right.
      lines.shift();
      this.discardingLine = false;
    }

    if (this.remainder.length > MAX_SERIAL_LINE_CHARS) {
      this.remainder = "";
      this.discardingLine = true;
    }

    return lines.filter((line) => line.trim());
  }
}

// Grows to 5s and holds. Retries are unlimited - the XIAO always comes back
// eventually, and an idle retry at the 5s ceiling costs nothing.
const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 5000];

// See the queue in startSerialTransport: this bounds how many lines may wait
// behind a transcription that is still running.
const MAX_QUEUED_LINES = 8;

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

    // The wire is serial and has to stay that way. Every handleLine path used to
    // finish before it returned, so the loop below was serial by accident;
    // voice/audio broke that by awaiting a transcription for up to 90 seconds.
    // Node keeps emitting 'data' throughout, so without this chain a second line
    // starts processing inside the first one's await: replies leave in completion
    // order rather than request order, and every overlapping transcription holds
    // its own copy of the audio on a 512 MB Pi.
    let queue: Promise<void> = Promise.resolve();
    let queuedLines = 0;

    async function processLine(line: string) {
      if (myGeneration !== generation) {
        return; // Torn down while this line waited its turn - abandon the backlog.
      }

      const response = await options.handleLine(line);

      if (myGeneration !== generation) {
        return; // Connection was torn down mid-await.
      }

      if (response === null) {
        return; // Not a request (debug chatter) - nothing to reply to.
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
      }
    }

    input.on("data", (chunk: Buffer) => {
      if (myGeneration !== generation) {
        return;
      }

      if (!receivedData) {
        receivedData = true;
        retryAttempt = 0;
        options.onConnect?.();
      }

      for (const line of buffer.push(chunk)) {
        // One voice line can hold the queue for 90 seconds. More than a handful
        // waiting behind it means the device has stopped listening for replies -
        // a reset mid-conversation, or a second writer on the tty - and each one
        // held is ~427 KB. Dropping is reported rather than silent; the retry for
        // a recording is pressing the pad again.
        if (queuedLines >= MAX_QUEUED_LINES) {
          options.onError(`Serial backlog full (${MAX_QUEUED_LINES} lines) - dropping input`);
          continue;
        }

        queuedLines++;
        queue = queue
          .then(() => processLine(line))
          .catch((error) => {
            // handleLine rejecting used to surface as an unhandled rejection,
            // because nothing awaited the 'data' listener that called it.
            const message = error instanceof Error ? error.message : String(error);
            options.onError(`Serial handler error: ${message}`);
          })
          .finally(() => {
            queuedLines--;
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
