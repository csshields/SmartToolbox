---
paths:
  - "api/src/**"
  - "firmware/**"
---

# Serial Protocol and Integration

How the XIAO and the Pi talk to each other. Both sides implement this, so it loads for
either. Triage of a link that has stopped working is the `hardware-debug` skill.

## Communication Protocol

### XIAO ESP32S3 ↔ Raspberry Pi Zero 2 Communication
- **Method**: Wired **USB serial** (USB-C, CDC/ACM virtual serial port) for all request traffic. Wi-Fi carries OTA firmware updates only, during `setup()`; BLE is unused.
- **Physical link**: Xiao's USB-C cable plugged into a USB port on the Pi Zero 2 (e.g., appears as `/dev/ttyACM0` on the Pi)
- **Protocol**: Newline-delimited JSON. Every Xiao request has a unique `id`, `type: "request"`, a supported `endpoint`, and a `body`. The Pi echoes the same `id` in every response. The Bun implementation reads/writes the CDC ACM device directly without a native serial-port addon.
- **The tty must be in raw mode.** Linux enumerates a ttyACM in *cooked* mode with echo on, which silently breaks the link in both directions: everything the XIAO transmits is echoed back into its own receive buffer, and `onlcr` rewrites outgoing newlines. The symptom is one-way traffic - the Pi logs `request` and `response written` normally while the XIAO times out having received nothing. `configureRawMode` in `api/src/serialTransport.ts` shells out to `stty -F <device> raw -echo` on every connect, because the settings reset each time the device re-enumerates on replug or reset.
- **Initial endpoints**:
  - `device/status`: heartbeat. Firmware version and `uptimeMs`, sent at boot and then
    every 30 seconds. Fire and forget - the firmware does not wait on the reply.
  - `tools/lookup`: Xiao sends recognized or transcribed text; Pi returns matching drawer labels and row indicators.
  - `vision/observe`: Xiao sends `drawerLabel`, model version, and a `detections` array of tool-type labels, confidence, quantity, and optional bounding boxes.
- **The device speaks first, always.** The protocol models requests from the XIAO and
  responses from the Pi; there is no Pi-initiated message type and the transport only
  ever writes responses. Nothing on the dashboard can push to the device. Control is
  therefore *queued and collected*, never sent.

  **Status: Implemented** 2026-08-29 (0.21.0) - `api/src/deviceCommands.ts`,
  `handleDeviceCommand` in the sketch, and `api/scripts/push-to-device.ps1`.
  `POST /api/devices/command` takes `check-firmware` or `reboot`; the command rides back
  on the body of the next `device/status` reply, which is why the heartbeat had to exist
  first. It waits at most one interval - 30 seconds normally, 2 seconds while the device
  is still waiting for the Pi at boot - instead of until the next reboot or touch.

  **Delivered exactly once, and there is no acknowledgement.** Collecting it *is* the
  acknowledgement: the Pi clears the command when it hands it over, because there is no
  Pi-initiated retry to build on and re-delivering on every heartbeat until something
  confirmed would turn a missed `reboot` into a reboot loop. The retry for a command that
  did not land is queueing it again. Commands are held in memory, not SQLite, and expire
  after five minutes - a command is an instruction about *now*, and one that survived a
  service restart to fire hours later would be a surprise rather than a feature.
- **The boot announcement cannot be relied on, and the design assumes it will be lost.**
  It is sent from `setup()`, while the USB serial port is still re-enumerating after a
  reset, so the Pi is often mid-reconnect-backoff and never sees it. This is not
  hypothetical: `boot_count` sat at zero through several confirmed reboots on hardware,
  and the OTA debug output for one of those boots is absent from the journal for the same
  reason. **Restarts are therefore detected from `uptimeMs` running backwards**, which
  rides on every heartbeat and so survives a lost announcement. `recordDeviceContact`
  owns that comparison; `millis()` wrapping at ~49.7 days reads as one spurious reboot,
  which is the accepted cost.
- **Heartbeats are not written to `request_logs`.** At one every 30 seconds they would
  add ~2,880 rows a day and bury the requests a person actually wants to read. The
  `devices` table already holds everything a heartbeat carries. Every other serial
  endpoint is still logged.
- **Every serial request is recorded.** `handleSerialLine` calls `recordDeviceContact`
  before dispatching - a request that is then rejected is still proof the XIAO is on the
  wire - and logs the outcome to `request_logs` with method `SERIAL`. Only
  `device/status` counts as a boot, and only it carries `firmwareVersion`, so the upsert
  must not let the other endpoints' empty string blank out the stored version. Guarded
  by `api/src/db.test.ts`.
- **Successful response**: `{"id":"req-001","success":true,"body":{...}}`
- **Error response**: `{"id":"req-001","success":false,"error":{"code":"INVALID_REQUEST","message":"drawer_label is required"}}`
- **Audio**: **Status: Implemented** 2026-08-29 (0.20.0), `api/src/voice.ts` and `sendVoiceAudio` in the sketch. Since 0.28.0 the capture has two triggers - the button and the "Hi ESP" wake word - but only one transport, and nothing below changes with the trigger. Audio is carried on this same link as a single base64 line on a `voice/audio` request - raw 16 kHz 16-bit mono PCM, roughly 171 KB of base64 for four seconds. The recording runs for as long as the button is held (300 ms minimum, 10 s cap), so its length is not known when the transfer starts: the device sends samples plus `sampleRate`/`channels` and **the Pi prepends the WAV header**. An earlier draft of the spec called for a separate chunked transfer protocol; that was reconsidered and rejected in `docs/PLAN-voice-lookup.md`, which records why (a chunked protocol needs reassembly state, partial-upload timeouts, and a resync path, where a single line needs only a retry - and the retry is pressing the button again). Raw binary framing was also rejected: the transport splits on newlines and PCM is full of `0x0A`. `SerialLineBuffer` has a maximum line length (`MAX_SERIAL_LINE_BYTES`, 600 KB) and the `[serial-debug]` echo truncates at 300 characters - both because a device that resets mid-line would otherwise grow the buffer until the process dies, and a mangled audio line landing in `service.log` in full would bury the lines that explain it. **Transcription is slow enough to need its own timeout:** measured against this NAS, one second of audio takes ~9.3s warm and the first call after an idle container exceeded 30s while the model loaded. The Pi allows 90s, the device 100s - the device deliberately longer, so it never abandons a request the Pi is still working on. The 2s `RESPONSE_TIMEOUT_MS` used for lookups would fire before Whisper had started.
- **Connectivity**:
  - XIAO ESP32S3 writes/reads framed JSON messages over its USB serial connection
  - Pi Zero 2 process listens on the serial device and dispatches to the same handlers used for the HTTP API
  - No network discovery needed (mDNS/static IP) since the link is a direct wire, not WiFi

### API Server ↔ Transcription

**Status: Implemented** 2026-08-29 - `transcribeAudio` in `api/src/voice.ts`, reached from
the `voice/audio` serial endpoint. Provider selection, persistence and the reachability
test were already there (`/api/settings/transcription`); what was missing was an audio
source, and the microphone now provides one.

- **Default provider**: self-hosted Whisper on the NAS, `http://192.168.50.10:9000`
  (Swagger docs at `/docs`). Stored in `config` as `transcription_nas_url`.
- **Fallback provider**: OpenAI, selected by setting `transcription_provider` to
  `openai`. Requires `OPENAI_API_KEY` in the environment.
- **Reachability test**: `nas_whisper` probes `<nasUrl>/docs`; `openai` probes
  `/v1/models` with the configured key. Both use a 5-second timeout.
- **The ASR request shape is taken from the service, not assumed.** NAS Whisper is
  `whisper-asr-webservice` 1.9.1: `POST <nasUrl>/asr?task=transcribe&output=txt&encode=true&language=en`
  with a multipart **`audio_file`** field. That field name differs from OpenAI's `file`,
  and a wrong one returns a bare 422 with nothing diagnostic in it - it came from the
  service's own `/openapi.json`. OpenAI uses `file` plus `model=whisper-1`.
- **The language is told, not detected.** `language=en` on both providers. Whisper guesses
  otherwise, and on this device's quiet audio a misdetected language turns a good
  recording into confident nonsense. It is also ~2.5s faster: a one-second probe went from
  ~9.3s to ~6.8s.
- **Timeout: 90 seconds, and that is measured rather than chosen.** One second of audio
  takes ~9.3s warm against this NAS, repeatably, and the first call after the container
  has idled blew through a 30s ceiling while the model loaded. The device allows 100s -
  deliberately longer, so it never abandons a request the Pi is still working on. No
  retries: a retry doubles a wait that is already ten seconds, and the retry for a
  recording is pressing the pad again.

### Data Format
Define binary or JSON format for sensor data transmission:
```cpp
// Example structure
struct SensorPacket {
  uint32_t timestamp;
  uint8_t sensor_type;  // 1=IMU, 2=Camera, 3=Mic
  uint16_t data_length;
  uint8_t data[];
};
```

## Integration

### Data Flow

```
Firmware (XIAO ESP32S3)
  ↓ [USB serial]
API Server (Bun on Raspberry Pi Zero 2)
  ↓ [SQLite]
Database (Storage in api/data/)
  ↓ [REST API]
Client Applications (Web Dashboard, Mobile App, etc.)
```

**Communication Paths**:
1. **XIAO ESP32S3 → Pi Zero 2**: Tool queries, detections, telemetry (USB serial)
2. **Pi Zero 2 → XIAO ESP32S3**: Tool locations, commands, configuration (USB serial response)
3. **XIAO ESP32S3**: Drives the OLED and matrix directly from API responses
4. **Dashboard → Pi Zero 2**: Drawer and tool management, settings, request log (HTTP,
   same origin). This is the only path fully working end to end today.

The serial and HTTP paths share handlers deliberately: `handleSerialRequest` in
`api/src/index.ts` calls the same `db.ts` functions the HTTP routes do, so a lookup
behaves identically whether it arrives over the wire or the network.

### Row-Aware Inventory Lookup

- A drawer has an exact display `label` (such as `1A`, `1B`, `1C`, or `3`) and a `row_number`.
- The Pi keeps the latest observation for each detected tool type and drawer, including quantity, confidence, model version, and timestamp.
- `GET /api/tools/lookup?query=needle-nose%20pliers` returns exact `drawers` for the OLED and a `rows` list collapsed by `row_number` for the matrix. When several drawers in one row match, the row takes the highest available confidence. `rows` counts only the toolbox the device is mounted on; `drawers` covers every toolbox. The `tools/lookup` serial endpoint returns the same payload.
- The camera's `drawerLabel` (serial `vision/observe`) is matched within the device's toolbox only, since that is where the camera is.
- `POST /api/vision/observations` accepts a `drawerId`, `modelVersion`, and `detections` array. Each detection contains `label`, `confidence` (0-100), and optional `quantity`.
- Tool identity is by type, not by individual physical instance. Multiple detections of a type in one drawer are represented by quantity.

### Message Format Standards

Use consistent data formats across both projects:
- Timestamps: Unix epoch (seconds or milliseconds)
- Device IDs: String format (e.g., "xiao-001")
- Binary data: Base64 encoding for transmission
- Metadata: JSON format

### Error Handling & Retries

- Firmware should queue data if connection lost
- API should validate all incoming data
- Implement exponential backoff for retries
- Log all communication errors
