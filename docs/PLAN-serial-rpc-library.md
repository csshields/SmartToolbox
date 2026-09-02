---
title: Plan of Attack - extract the device-initiated serial RPC into a matched pair
scope: implementation plan, written 2026-09-02 - lift the JSON-over-serial request
  protocol out of api/src and smarttoolbox.ino into one repo shipping two packages, an
  npm host library and an Arduino device library, after a survey found the closest
  existing library runs in the opposite direction
status: PLANNED - nothing built. The TS half is the best-tested code in this repo and
  can be extracted safely today; the firmware half is entangled with app endpoints and
  needs the shape settled first. Do not publish either until the conformance fixtures
  in Phase 3 pass on both sides.
---

# Plan: line-delimited JSON RPC over serial, where the device speaks first

One sentence of scope:

> The wire between a microcontroller and its companion SBC - framing, request IDs,
> timeouts, reconnects, and the tty hygiene nobody warns you about - becomes one repo
> shipping two packages that agree on a format, without SmartToolbox's four endpoints
> coming along.

## Context: what the survey found

**Framing libraries.** [SerialTransfer](https://github.com/PowerBroker2/SerialTransfer)
does packetised binary transfer with CRC and 1-254 byte payloads;
[PacketSerial](https://github.com/bakercp/PacketSerial) does COBS/SLIP encoding so any
byte value survives the wire. Both are the layer *below* this. Neither has a request
identity, a response, a timeout, or a notion of who is allowed to speak.

**[simpleRPC](https://github.com/jfjlaros/simpleRPC)** is the closest real match and is
genuinely good: it exports Arduino functions with automatic type inference and ships
[a Python host client](https://pypi.org/project/arduino-simple-rpc/). It is also
**inverted**. In simpleRPC the host calls into the device; here the device initiates and
the companion answers. That is a different topology, not a configuration flag - and it is
the topology of every "MCU with a Pi doing the heavy lifting" build, where the MCU owns
the sensors and the SBC owns the database.

**The wider command/telemetry family**, checked second pass, and all of it lands in one of
three places that are not this:
[CmdMessenger](https://github.com/thijse/Arduino-CmdMessenger) is command/callback with a
.NET host and no response correlation;
[Telemetrix](https://mryslab.github.io/bots-in-pieces/arduino,stm32,firmata/2020/09/20/telemetrix-phase-1.html)
*is* device-initiated but is a fixed protocol for GPIO and sensor telemetry with a Python
client, not a way to ask the host an application question; Firmata is host-driven;
[micro-ROS](https://github.com/micro-ROS/micro_ros_arduino) is genuinely device-initiated
but drags in an agent and DDS, which is several weight classes above a toolbox.

So the pattern across every near-miss is the same: host-driven, Python-hosted, or far too
heavy. None is "the device asks its companion an application-level question over
newline-delimited JSON, with a Node host".

**[node-serialport](https://www.npmjs.com/package/serialport)** with `ReadlineParser` is
the host-side transport this builds on rather than replaces. Worth noting explicitly: it
does **not** solve the cooked-mode problem below, which is why this codebase shells out
to `stty`.

**Conclusion: build it**, and be honest that the audience is narrower than StatusFace's.
The value is not "JSON over serial" - anyone can `JSON.parse` a line. It is the
half-dozen things that are invisible until they cost you a day:

- **A freshly enumerated `ttyACM` is a terminal, not a pipe.** It arrives in cooked mode
  with echo on, so every byte the device sends is echoed back into its own receive
  buffer, and `onlcr` rewrites outgoing newlines. `stty raw -echo` is the fix and it has
  to be reapplied on **every** connect, because the settings reset when the device
  re-enumerates on replug or reset. See `configureRawMode` in `serialTransport.ts`.
- **An oversized line must be discarded all the way to its newline.** Clearing the
  remainder alone is not enough - the rest of that same line keeps accumulating and comes
  back as a complete line of its own. In this project that surfaced as a base64 fragment
  arriving at the request handler and being logged as debug chatter. See
  `discardingLine`.
- **The buffer needs a cap at all**, or a device that resets mid-line grows it until the
  process dies. Dropping one line costs one operation; the retry for an operation is
  doing it again.
- **Request IDs, or you cannot tell a late answer from the current one.** The device
  correlates on `pendingRequestId` and discards anything that does not match.
- **A response timeout is not optional**, because the peer can simply never answer, and
  the device must return to a usable state rather than waiting forever.
- **Reconnect backoff that grows and then holds.** `[500, 1000, 2000, 4000, 5000]`, then
  5s indefinitely - the MCU always comes back eventually, and an idle retry at the
  ceiling costs nothing.

## What the layers are

Today the host half is already close to this shape; the device half is not.

**1. Framing.** `SerialLineBuffer` on the host, `serialLineBuffer` on the device. Split
on newline, cap the line, discard to the newline on overflow. Nothing above this layer
knows what a line means.

**2. Protocol.** The envelope, and only the envelope:

```jsonc
// device -> host
{ "id": "req-7", "type": "request", "endpoint": "tools/lookup", "body": { } }
// host -> device
{ "id": "req-7", "success": true,  "body": { } }
{ "id": "req-7", "success": false, "error": { "code": "...", "message": "..." } }
```

Parse, validate, construct, serialise. No I/O. This is `serialProtocol.ts` almost
unchanged.

**3. Session.** The stateful half, and different on each end. Host: open the tty, set raw
mode, reconnect with backoff, queue inbound lines behind a slow handler. Device: assign
IDs, track the one in flight, time it out, hand the response to a callback.

## The API, sketched

Host (npm):

```ts
const link = createSerialLink({
  path: "/dev/ttyACM0",
  endpoints: ["tools/lookup", "device/status"] as const,  // generic, not baked in
  maxLineChars: 600_000,
  handlers: {
    "tools/lookup":  async (body) => ok({ row: 3 }),
    "device/status": async ()     => ok({ ready: true }),
  },
});
```

Device (Arduino):

```cpp
SerialLink link(Serial);
link.onResponse(handleResponse);
link.request("tools/lookup", body);   // returns the assigned id, or fails if one is in flight
link.poll();                          // from loop(), non-blocking
```

**One in-flight request, deliberately.** The device today carries a single
`pendingRequestId` and an `awaitingResponse` bool, not a table. Keep that: it matches
what an MCU has RAM for, it makes the timeout trivial, and a device that needs two
concurrent requests usually wants a queue instead. Document it as a constraint rather
than an oversight, and let `request()` fail fast when one is already out.

## What stays in SmartToolbox

- The four endpoint names. `SerialEndpoint` becomes a type parameter and a
  runtime-registered set; `tools/lookup` and `vision/observe` mean nothing to anyone else.
- Everything in `handleIncomingLine` past the envelope - tool names, drawer rows,
  certainty, the OLED and matrix calls.
- `voice/audio` and its base64 PCM payload. The 600,000-character cap is *derived* from
  it (ten seconds of 16 kHz 16-bit mono is 320 KB, which base64 inflates to ~427 KB, plus
  JSON overhead). In the library that becomes a constructor option with the derivation in
  the doc comment, so a consumer sizes it from their own largest message.

## Phases

### Phase 0 - make the endpoint set injectable, in place

The one change that decides whether this is extractable. `serialProtocol.ts` currently
closes over a hardcoded `serialEndpoints` Set. Make the set a parameter, thread it
through `parseSerialRequest` and `dispatchSerialRequest`, and update the callers.

The existing tests should pass untouched. If they do not, the boundary is in the wrong
place.

### Phase 1 - split framing from protocol from session, host side

Three modules behind today's names. `SerialLineBuffer` moves out clean - it already has
no dependencies. `configureRawMode`, the retry table and the queue become the session.

**This half is nearly free**, and that is not luck: `serialTransport.ts` is 277 lines
against 269 lines of test, and `serialProtocol.ts` is 91 against 31. Extraction is safe
in exactly the places where tests already pin the behaviour.

### Phase 2 - give the device half a shape

Harder, because there is nothing to extract cleanly yet - the firmware's serial code is
scattered across `pollSerialResponses`, `handleIncomingLine`, `pollResponseTimeout`,
`sendToolLookupRequest` and `sendDeviceStatus`, and it reaches into `awaitingResponse`,
`pendingToolName`, the OLED and the matrix.

Pull out a `SerialLink` class owning only: the inbound buffer, `requestCounter`,
`pendingRequestId`, `pendingSince`, and the timeout. Everything else stays in the sketch
behind an `onResponse` callback.

**Replace the `String` line buffer with a fixed `char[]` while you are here.** Inbound
lines are small - the device *sends* audio, it never receives it - so a fixed buffer is
sized by the largest expected response, and it removes the heap churn that a `String`
accumulating byte-by-byte in an interrupt-adjacent path invites.

### Phase 3 - one repo, two packages, shared fixtures

Two languages implementing one wire format drift. The mechanism that stops it:

```
serial-rpc/
  PROTOCOL.md              the envelope, normative
  fixtures/*.json          wire samples: valid, malformed, oversized, wrong-id
  js/                      npm package, tests read ../fixtures
  arduino/                 library.properties + src/, host-compiled tests read ../fixtures
```

**The fixtures are the contract.** Both sides' test suites parse the same files and must
agree on which are valid and what they decode to. This is the same trick as the golden
frames in `PLAN-status-face-library.md`, and for the same reason: a shared artifact both
implementations are checked against beats two implementations checked against their own
authors.

One repo rather than two, because a version skew between the halves is the failure mode
that matters and a single tag makes it visible.

### Phase 4 - publish

npm for the host package; Arduino Library Manager for the device one, by the process in
`PLAN-status-face-library.md` Phase 4. Only after the fixtures pass on both sides.

## Known constraints, stated rather than discovered later

- **`stty` is Unix-only, and this is why the serial listener does not start on Windows
  here** (see `CLAUDE.md`). The library must either declare itself Linux/macOS, or set
  the equivalent through node-serialport's own open options on Windows. Decide before
  publishing - a package that silently does nothing on a third of installs is worse than
  one that refuses to load.
- **Line-oriented means no binary.** base64 costs 33% and a 427 KB line is not free to
  buffer on either end. Anything genuinely large should use a side channel; say so in the
  README rather than letting someone discover it at 10 MB.
- **One in-flight request per device.** See above - a constraint, documented.
- **Device-initiated only.** There is no host-initiated message type. The out-of-band
  answer to that is the heartbeat command queue, which belongs to
  `PLAN-firmware-delivery-library.md`, not here. Keep them separate; conflating them is
  how this grows into a framework.

## Open questions

1. **Keep `endpoint`, or adopt JSON-RPC 2.0?** The current envelope is REST-shaped
   (`endpoint` + `body`). Switching to JSON-RPC's `method`/`params`/`result`/`error`
   would buy an existing spec, existing tooling, and instant familiarity, at the cost of
   a slightly noisier wire and a migration on both ends. Worth deciding at Phase 3, while
   the fixtures are being written and before anything is published - this is the one
   decision that is expensive afterwards.
2. **Does the host package own the transport, or take a stream?** Taking a duplex stream
   makes it testable without hardware and usable over TCP or a pty; owning the tty is what
   makes `configureRawMode` possible. Suggest: take a stream, and ship the tty opener as a
   separate exported helper.
3. **Name.** It should not say "serial" only, since a stream-shaped API works over more
   than a tty. But it should not oversell either.
