---
paths:
  - "firmware/**"
---

# Feature Specifications

The four features of the box, and the state machine meant to tie them together. Much of
this is design rather than code - **read each section's status tag before building on
it**. The API endpoints these features call are in `api.md`.

## Feature 1: Wake Mode (Motion-Activated)

**Status: Planned** - the PIR is wired to GPIO1 as of the 2026-09-02 rewire and nothing
reads it. It is no longer blocked on hardware, merely unwritten. The design below is
unvalidated: no part of it has run on hardware.

**Purpose**: Automatically activate the toolbox when motion is detected, providing illumination and readying the camera for tool identification.

**Hardware Requirements**:
- PIR motion sensor, wired to GPIO1 on the expansion base's A0/D0 Grove port
- 8x8 RGB LED matrix (MVP row indication)
- OLED display (MVP status display)

**Behavior**:
1. **Idle State**: System in low-power mode, only PIR sensor active
2. **Motion Detection**: PIR sensor triggers interrupt
3. **Wake Activation**:
  - Show ready status on the OLED and matrix
   - Power up camera module
   - Initialize microphone for keyword detection
   - Start activity timer
4. **Active State**: All systems ready, monitoring for user interaction
5. **Timeout**: After **10 minutes** of no motion detected, return to idle state
6. **Activity Extension**: Any new motion detection resets the 10-minute timer

**Configuration Options**:
- Timeout duration (default: 10 minutes, configurable via API or serial)
- LED brightness levels
- PIR sensitivity (if supported by hardware)

**Power Considerations**:
- Use PIR interrupt to wake from deep sleep
- The OLED and matrix operate from the existing low-power I2C setup
- The WS2813 strip runs under-volted from a 3.3V Grove port and needs its own 5V
  supply before it is mounted - see `docs/HARDWARE.md`

---

## Feature 2: Tool Drawer Requests (Voice-Activated)

**Status: Partial** - **the voice path is complete end to end as of 0.22.0**: hold the
pad, say what you want, and the matrix lights the row while the OLED names the drawer.
The transcript half was proven by a person speaking to the box rather than by inspection
("Massachusetts" was said and came back exactly), and `resolveToolQuery`
(`api/src/db.ts`) now turns what was said into a tool the box owns - `where are my
needle nose pliers` resolves to `Needle-Nose Pliers` in row 2, a query that returned
"not found" the day before.

**The wake word shipped in 0.28.0 and is proven on hardware (2026-10-04).** Saying
"Hi ESP" starts the same capture the button starts: a person said it at the box, it
recorded its four-second window, and Whisper heard "screwdriver". It needs a partition
change, so it arrives over a USB cable, never OTA. The audio is quiet (rms around 50), so
if it stops firing from a distance, look at the microphone level before the code.

Three things about it are worth knowing before reading the code:

- **The phrase is fixed at "Hi ESP" and is not configurable**, whatever step 1 of the Workflow below says. The prebuilt esp-sr libraries in the pinned core compile exactly one wake word; every other phrase in the sdkconfig is switched off. Changing it means rebuilding `esp32-arduino-libs`, and a phrase of our own means commissioning Espressif. See Decision 1 in `docs/PLAN-onboard-commands.md`.
- **The button is unchanged and stays.** Both triggers run the same capture through `recordAndReportMic`. The button is what still works when recognition does not, and the two are told apart on the OLED so that a failure of one is visible rather than silent.
- **The recording window is fixed at four seconds** rather than ended by silence. A wake word has no release edge, and a silence threshold on audio that sits at 4-10% of full scale is the kind that ends a recording mid-word. See `WAKE_RECORD_MS` in the sketch.

**The known risk is the microphone, and it is not small.** ESP-SR's WakeNet is fussier
than Whisper is, and Whisper already mis-hears this audio. The plan's Phase 1 existed to
measure whether this microphone drives WakeNet at all, and it was skipped in favour of
building the feature - so that measurement is now the first thing the box will report,
rather than something known in advance. If "Hi ESP" needs shouting, gain and DC-offset
correction on the mic feed are the prerequisite: `docs/PLAN-mic-bringup.md` Step 1.

Three things are thin rather than done. The audio sits at roughly 4-10% of full scale -
the DC offset is not stripped and no gain is applied, so the margin is narrower than it
should be; see `docs/PLAN-mic-bringup.md`. Whisper is told `language=en` rather than
left to guess, which is both more reliable on quiet audio and about 2.5s faster. And the
dashboard has no voice-test panel, so the flow can only be exercised at the box - the
one piece of `docs/PLAN-voice-lookup.md` Phase 1 that was not built.

Row indication runs on the 8x8 matrix via `matrixFillRow` and, since 0.27.0, on the
WS2813 strip beside it: one LED lights next to the matching row, coloured by the same
certainty rule. Proven on hardware 2026-09-02. The lookup half is reachable without any of the
voice path, through `GET /api/tools/lookup` and the `tools/lookup` serial endpoint, so
the dashboard can exercise it directly.

`docs/PLAN-voice-lookup.md` is the implementation plan for this feature. The audio
travels from the XIAO's **on-board PDM microphone** to the Pi **over the USB serial
link**, as a single base64 line on the `voice/audio` endpoint - not over Wi-Fi, so the
radio keeps its one job of OTA updates and the voice path depends on only one device
being on the network.

**Purpose**: Allow users to request tool locations via voice commands, with visual feedback via color-coded LED indicators.

**Hardware Requirements**:
- The XIAO's on-board PDM microphone on the Sense board (no external module - see Status)
- 8x8 RGB LED matrix (one position per row; 6 rows total)
- OLED display for exact drawer labels
- USB serial connectivity to the API (see `serial-protocol.md`)

**Workflow**:

1. **Keyword Detection**:
   - Continuously listen for wake word: **configurable** (e.g., "Smart Toolbox")
   - Default keyword: "Smart Toolbox" (stored in configuration)
   - Support for alternative keywords via API configuration endpoint

2. **Audio Capture**:
   - After keyword detected, record next **3-5 seconds** of audio
   - Format: WAV or compressed audio (e.g., Opus)
   - Buffer audio in RAM before transmission

3. **Audio-to-Text Conversion**:
   - **Decision**: two providers, selectable at runtime. Self-hosted Whisper on the NAS
     is the default; OpenAI is a fallback for when the NAS is down or its accuracy is
     not good enough. Whisper does not run on the Pi Zero 2 itself - 512MB is not
     enough RAM.
   - Default: `http://192.168.50.10:9000` (Swagger docs at `/docs`)
   - Stored in the `config` table as `transcription_provider` (`nas_whisper` |
     `openai`) and `transcription_nas_url`, so both can change without a redeploy.
     Configurable from the dashboard's Transcription Settings panel.
   - The OpenAI path requires `OPENAI_API_KEY` in the environment. The API reports
     whether it is present as `openaiApiKeyConfigured` but never returns the key.
   - **Tradeoff to keep in mind**: `nas_whisper` keeps audio on the LAN and costs
     nothing but needs the NAS up; `openai` is more accurate but sends audio off the
     network. Default to `nas_whisper` for anything routine.
   - Include timeout and retry logic (5-second timeout, 2 retries). The reachability
     probe in `POST /api/settings/transcription/test` already uses a 5-second timeout.

4. **API Request**:
   - Send transcribed text to API endpoint: `POST /api/tools/identify`
   - Request format:
   ```json
   {
     "device_id": "xiao-001",
     "timestamp": 1234567890,
     "query": "screwdriver",
     "audio_url": "optional-storage-url"
   }
   ```

5. **API Response**:
   - **Unknown Tool**:
   ```json
   {
     "success": true,
     "found": false,
     "message": "Tool not found"
   }
   ```
   - **Tool Identified** (`row_number` is what actually drives the LED; `drawer_id` is the specific drawer for logging):
   ```json
   {
     "success": true,
     "found": true,
     "tool_name": "Phillips Screwdriver",
     "drawers": [
       { "drawer_id": 3, "row_number": 1, "certainty": 95 },
       { "drawer_id": 7, "row_number": 4, "certainty": 60 },
       { "drawer_id": 12, "row_number": 6, "certainty": 25 }
     ]
   }
   ```
   - If multiple drawers within the **same row** match (relevant for row 1's 3 drawers), the API collapses them to a single entry using the highest certainty for that row.

6. **Visual Feedback**:
   - **Unknown Tool**: 
     - Flash all row positions on the matrix **red** 3 times
     - Display "UNKNOWN" on the OLED
     - Play error tone (optional buzzer)
   
   - **Tool Found**: 
     - Light up each matching row's matrix position based on certainty:
       - **High certainty (80-100%)**: **Solid Green**
       - **Medium certainty (40-79%)**: **Solid Orange**
       - **Low certainty (10-39%)**: **Solid Blue** (or Purple/Cyan as alternative)
       - **Very low certainty (<10%)**: Do not illuminate
     - Show exact drawer labels on the OLED, such as `1A, 3`
     - Keep indicators lit for **30 seconds** or until a new interaction

7. **User Feedback**:
   - Optional: Play confirmation beep when keyword detected
   - Optional: Pulse LED during audio recording
   - Optional: Display transcribed text on OLED/LCD if available

**Configuration Options**:
- Wake word/keyword (string, stored in config)
- Transcription service URL and API key
- Certainty thresholds for LED colors
- LED color scheme (customizable RGB values)
- Timeout durations (recording, API call)
- Audio quality settings (sample rate, bit depth)

**Error Handling**:
- Network timeout: Flash yellow, retry once
- Transcription failure: Flash red, log error
- Microphone failure: Log to serial, disable feature
- Invalid API response: Log and display error code

---

## Feature 3: Watch Tools Leave and Return

**Status: Blocked** - the Vision AI V2 is connected and the I2C link works, but **no
SenseCraft model is deployed**, so there is nothing to detect. Deploying a model
trained on the actual tools is the single next step that unblocks this feature. The
API side is ready: `POST /api/vision/observations` and the `vision/observe` serial
endpoint both accept and store detections today. `docs/PLAN-tool-presence.md` is the
implementation plan; its Steps 1 and 2 need no hardware and can be built against
fixtures before the model lands.

**Purpose**: Detect **both directions** - a tool leaving a drawer and a tool being put
back - and keep a history of each, so the box can say what is out and how long it has
been out.

### Presence model - decided 2026-08-31

Tools stay tracked **by type and quantity**, as everywhere else in this system, and
presence is derived rather than flagged. The camera writes one `tool_movements` row per
observed change; comparing the movements against `tools.quantity` gives
`present` / `partial` / `away` / `unknown` without storing a status anybody has to keep
in step.

**Why not a per-instance `inUse` flag**, which is the obvious shape and was considered
first:

- **A boolean cannot count.** Three Phillips screwdrivers, one leaves: the row says
  `quantity: 3` and the flag has no honest value. The interesting state is *2 of 3*.
- **Identity needs a source, and the camera is not one.** The Vision AI V2 emits a class
  label and a confidence - `phillips_screwdriver, 87%` - and cannot tell your second
  screwdriver from your third. Instance rows would force every camera event to be
  assigned to *some* instance, producing a movement history that looks authoritative and
  is partly invented. **A fabricated history is worse than none**, for the same reason a
  stale status tag is worse than no tag.
- **Returning to a different drawer already works** without instances. `tools` is keyed
  `(drawer_id, name)`, so one tool type holds rows in several drawers at once, and
  `locateTool` already returns every drawer a name lives in. Take one from 1A, put it
  back in 3, and the counts move; a lookup lights both rows.

**The gate for per-instance tracking is a real identity source** - engraving, QR, NFC, or
a set whose members are visibly different. There is no plan to mark the tools as of
2026-08-31, so the gate is closed. If it opens, `tool_movements` is already the right
shape to hang instances on, and nothing built now has to be undone.

**Hardware Requirements**:
- Grove Vision AI Module (V2) + OV5647 camera
- Row indicator LEDs (for feedback)
- Optional: Hall effect sensors or photointerrupters per drawer (for drawer open/close detection)

**Workflow**:

1. **Drawer Event Detection**:
   - **Method A (Sensors)**: Use hall effect sensors or photointerrupters to detect drawer opening/closing
   - **Method B (Periodic)**: Periodically scan all drawers when in wake mode
   - **Method C (Manual Trigger)**: User presses button to trigger return scan

2. **Tool Identification**:
   - When drawer closes (or on trigger), capture image of drawer contents
   - Send image to API endpoint: `POST /api/tools/identify-return`
   - Request format:
   ```json
   {
     "device_id": "xiao-001",
     "timestamp": 1234567890,
     "drawer_id": 5,
     "image_data": "base64-encoded-jpeg",
     "event_type": "drawer_closed"
   }
   ```

3. **API Processing**:
   - **Default**: Identification happens on-device on the Grove Vision AI Module's WiseEye2 MCU (SenseCraft AI-deployed model), which sends only the tool name/confidence to the API — raw images do not leave the device. Cloud vision fallback (e.g., Claude, GPT-4o) remains an option if on-device accuracy proves insufficient.
   - Compare with inventory database
   - Detect if tool is new, returning, or duplicate
   - Response format:
   ```json
   {
     "success": true,
     "tool_identified": true,
     "tool_name": "Phillips Screwdriver #2",
     "tool_id": "tool-12345",
     "drawer_id": 5,
     "action": "returned",
     "confidence": 88
   }
   ```

4. **Visual Feedback**:
   - **Successful Return**: 
     - Flash the drawer's row LED **green** 2 times
     - Log event to database
   - **New Tool Detected**: 
     - Flash the drawer's row LED **blue** 3 times
     - Prompt user for tool name (via app or display)
   - **Unknown Object**: 
     - Flash the drawer's row LED **yellow** once
     - Log for manual review
   - **Identification Failure**: 
     - No LED change
     - Log error to serial

5. **Inventory Update**:
   - Update tool location in database
   - Record timestamp of return
   - Update tool usage statistics (time out, time returned)
   - Optional: Generate usage report

**Configuration Options**:
- Enable/disable automatic scanning
- Image capture resolution (balance quality vs. upload time)
- Identification confidence threshold
- Scan interval (if using periodic method)
- Drawer sensor configuration (if using hardware sensors)

**Advanced Features** (Future):
- Machine learning model on-device for faster identification
- Tool condition assessment (wear, damage)
- Missing tool alerts
- Usage pattern analysis

---

## Feature 4: Firmware OTA Updates (Wi-Fi Over-The-Air)

**Status: Implemented** - working end to end as of 2026-08-27. The device pulled
`smarttoolbox-0.4.0.bin` (1,046,256 bytes) from the Pi over Wi-Fi, verified it, rebooted
into it, and reported `currentVersion=0.4.0` on the next check. No cable involved.

The design below describes a broader system (AP-mode provisioning, rollback tracking,
a `firmware_updates` table). What is actually built is deliberately smaller:

- `GET /api/firmware/latest?currentVersion=X` on the Pi, guarded by `X-Device-Key`.
- A drop folder at `~/smarttoolbox/firmware/`, filled by `api/scripts/release-firmware.ps1`.
- A check in the firmware's `setup()` only. Wi-Fi is joined, the check runs, and the
  radio is switched off again before `loop()` starts - USB serial remains the link for
  all normal operation.
- No AP-mode provisioning and no update history table. Credentials come from
  `arduino_secrets.h` at compile time.

**Recovery from a bad build, over the cable already there.** An application-level
update needs working firmware to receive it, so a build that crashes in `setup()`,
wedges the loop, or breaks the serial link cannot be replaced over the air - the thing
that would accept the next update is the thing that is broken. That gap is closed, and
closing it no longer costs a trip to the box. **Status: Implemented** 2026-08-29 -
`api/scripts/flash-device.ps1` and `flash-device.sh`, per `docs/PLAN-usb-flashing.md`.
The Pi flashes the device with `esptool` over the cable already carrying `/dev/ttyACM0`,
talking to the ROM bootloader, which runs before the application and therefore survives
its own bad output.

**Proven against a real brick**, not a hypothetical one: a build that hangs on the first
line of `setup()` - no serial, no heartbeat, and never reaching the OTA check - was
silent for three minutes and recovered from Windows in 47 seconds with nobody touching
the box. `BRICK_TEST` in the sketch reproduces it.

Traps recorded in the plan: Debian's `esptool` is `+dfsg` with its stub flashers stripped,
so `--no-stub` is mandatory and its absence fails *late*, after connect and chip
detection; the binary is `/usr/bin/esptool`, absent from a non-interactive SSH shell's
PATH; the **merged** image must be flashed, never the app binary, which at `0x0` would
overwrite the bootloader; and the whole path depends on `cdc_on_boot=1` keeping USB alive
when the application hangs.

**Untested:** recovery from a transfer interrupted mid-write. The mechanism is sound -
the ESP32 writes to the inactive OTA slot and `Update.end(true)` only marks it bootable
after verifying the image - but that path has not been deliberately exercised.

**Hardware requirement:** the external antenna must be attached. See
`firmware.md`.

**Purpose**: Enable secure, remote firmware updates for the XIAO ESP32S3 without requiring 
physical access or manual re-flashing.

**Architecture Overview**:

1. **Device-side (XIAO)**:
   - Wi-Fi credentials stored in ESP32 NVS (Non-Volatile Storage)
   - Initial setup via AP (Access Point) mode on first boot
   - Periodic update checks (hourly default) via serial to Pi
   - Built-in rollback via ESP32 bootloader on failure

2. **Server-side (Pi API)**:
   - Firmware version management and binary hosting
   - Update checks via new serial endpoints
   - Binary serving with checksum validation
   - OTA event audit trail

3. **Integration**:
   - Extend serial protocol with `device/ota-check`, `device/ota-confirm`, `device/ota-reset` endpoints
   - Add firmware version, history, and status tables to SQLite
   - Dashboard UI for checking updates and viewing history

**Hardware Requirements**:
- Wi-Fi capability (already on XIAO ESP32S3)
- 3.5MB free flash space for OTA partition (8MB XIAO has this)

**Firmware Bootstrap Process**:
1. **First boot**: Check for Wi-Fi credentials in NVS
2. **If missing**: Enter AP mode (SSID: `SmartToolbox-{MAC}`, password: `12345678`)
3. **AP mode**: Host simple HTTP form on port 80 to accept credentials
4. **On save**: Reboot and attempt Wi-Fi connection
5. **On failure**: Retry 3 times with backoff, then return to AP mode
6. **On success**: Begin hourly update checks via serial

**Update Flow**:
1. Device sends `device/ota-check` request with current version via serial
2. Pi queries latest available version from database
3. Pi responds with version + download URL + SHA256 checksum (if update available)
4. Device downloads firmware binary over Wi-Fi (streaming to avoid RAM exhaustion)
5. Device validates checksum during download
6. Device flashes to OTA partition using Arduino `Update` class
7. Device reboots with new firmware
8. Device sends `device/ota-confirm` within 30 seconds to complete update
9. If no confirmation, bootloader auto-rollback to previous partition on next boot

**Configuration**:
- OTA check interval: configurable via serial (default 3600 seconds / 1 hour)
- Automatic update: opt-in via serial config
- Update can be triggered on demand with `api/scripts/push-to-device.ps1 check-firmware`, or `release-firmware.ps1 -Push -Now` to publish and fetch in one step. **There is no `device/ota-reset` command** - an earlier draft of this section named one and it was never built. See the device command queue in `serial-protocol.md` for what actually exists.

**Safety Features**:
- Checksum validation mandatory before flash (SHA256)
- Bootloader-level rollback (automatic on crash, explicit via serial)
- Explicit confirmation required after update (proves device booted successfully)
- Previous version stored in NVS for easy rollback via dashboard
- Exponential backoff on failures (prevents server spam)
- Device MAC address included in check requests (audit trail)

**Error Handling**:
- Download interrupted: retry with exponential backoff (max 3 attempts)
- Checksum mismatch: abort, retry later
- Wi-Fi disconnected: queue check, retry next check cycle
- Insufficient storage: report via serial, abort
- Server unreachable: exponential backoff (10min → 20min → 1hr cap)

**Dependencies**:
- WiFi (ESP32 built-in)
- Update (ESP32 built-in)
- WiFiClientSecure (ESP32 built-in)
- Preferences (ESP32 built-in) - wrapper around NVS
- ArduinoJson (already required)

**Implementation Files**:
- `firmware/smarttoolbox/WiFiManager.h` - NVS storage, AP mode, Wi-Fi connection
- `firmware/smarttoolbox/OTAManager.h` - Version checking, download, flash, rollback
- `api/src/serialProtocol.ts` - New OTA endpoints
- `api/src/index.ts` - OTA request handlers and binary serving
- `api/src/db.ts` - New firmware_versions and device_ota_history tables

**API Endpoints (New)**:
```
GET  /api/firmware/latest          - Latest firmware version + metadata
GET  /api/firmware/v{version}.bin  - Download firmware binary (validated by device)
POST /api/device/ota-check         - Check for updates (serial endpoint)
POST /api/device/ota-confirm       - Confirm update success (serial endpoint)
POST /api/device/ota-reset         - Reset Wi-Fi config (serial endpoint)
GET  /api/device/ota-status        - Current device OTA status (HTTP endpoint)
GET  /api/firmware/history         - OTA event history (HTTP endpoint)
```

**Serial Protocol Extensions**:
```json
// Check for update (device → Pi)
{"id":"ota-1","type":"request","endpoint":"device/ota-check","body":{"firmwareVersion":"1.2.3","macAddress":"...","wifiConnected":true}}

// Response: update available
{"id":"ota-1","success":true,"body":{"available":true,"version":"1.3.0","url":"http://192.168.50.30:3000/api/firmware/v1.3.0.bin","size":524288,"checksum":"sha256:abc123..."}}

// Confirm update (device → Pi)
{"id":"ota-2","type":"request","endpoint":"device/ota-confirm","body":{"previousVersion":"1.2.3","newVersion":"1.3.0"}}

// Response
{"id":"ota-2","success":true,"body":{"acknowledged":true}}
```

**Database Additions**:
```sql
-- New tables for OTA system
CREATE TABLE firmware_versions (
  id INTEGER PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  release_date TEXT NOT NULL,
  release_notes TEXT,
  bin_path TEXT NOT NULL,
  checksum TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE device_ota_history (
  id INTEGER PRIMARY KEY,
  device_id TEXT,
  from_version TEXT,
  to_version TEXT,
  status TEXT CHECK (status IN ('pending','checking','downloading','flashing','success','rollback','failed')),
  error_message TEXT,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE device_wifi_config (
  device_id TEXT PRIMARY KEY,
  ssid TEXT,
  configured_at TEXT,
  last_connected TEXT,
  ip_address TEXT
);
```

**Dashboard Features**:
- Display current firmware version
- "Check for Updates" button (manual trigger)
- Update history table (timestamp, version, status)
- Rollback button (if previous version available)
- Wi-Fi connection status indicator
- OTA status live indicator (idle, checking, downloading, flashing)

**Implementation Phases**:
- **Phase 1 (Week 1)**: Core infrastructure (WiFiManager, OTAManager, serial endpoints)
- **Phase 2 (Week 1-2)**: Device-side implementation (AP mode, update loop, Wi-Fi connection)
- **Phase 3 (Week 2)**: Server-side implementation (binary hosting, version management)
- **Phase 4 (Week 2)**: Rollback & safety (bootloader verification, confirm flow)
- **Phase 5 (Week 3)**: Dashboard UI (status display, update triggers, history)
- **Phase 6 (Week 3)**: Testing & documentation

**Estimated Effort**: 3-4 weeks (split across phases 1-3 for MVP; phases 4-6 follow)

---

## Firmware State Machine

**Status: Planned** - nothing below exists. The sketch has no `SystemState`; its only
state enum is `MatrixMode`, which drives the display (see Matrix States in `firmware.md`).

To manage the complex interactions between features, implement a state machine:

```cpp
enum SystemState {
  STATE_IDLE,           // Low power, PIR only
  STATE_WAKE,           // Motion detected, initializing
  STATE_ACTIVE,         // Fully active, monitoring
  STATE_LISTENING,      // Keyword detected, recording audio
  STATE_PROCESSING,     // Waiting for API response
  STATE_INDICATING,     // Displaying LED feedback
  STATE_SCANNING,       // Capturing images for tool return
  STATE_ERROR           // Error state, requires reset
};

SystemState currentState = STATE_IDLE;
unsigned long lastActivityTime = 0;
const unsigned long WAKE_TIMEOUT = 600000; // 10 minutes in ms
```

**State Transitions**:
- `IDLE → WAKE`: PIR interrupt triggered
- `WAKE → ACTIVE`: Initialization complete
- `ACTIVE → LISTENING`: Keyword detected
- `LISTENING → PROCESSING`: Audio captured, sent to API
- `PROCESSING → INDICATING`: API response received
- `INDICATING → ACTIVE`: Feedback complete
- `ACTIVE → SCANNING`: Drawer closed event
- `SCANNING → ACTIVE`: Image captured and sent
- `ANY → IDLE`: Timeout exceeded (10 min no activity)
- `ANY → ERROR`: Critical failure detected

---

## Updated Firmware Architecture

**Status: Planned** - the target shape once the state machine above exists. It assumes
NVS credentials, AP mode and hourly in-loop OTA checks, none of which were built; see
Feature 4 for what was.

```cpp
void setup() {
  // 1. Initialize USB serial (115200 baud)
  // 2. Initialize I2C bus and peripherals (Vision AI V2, OLED, 8x8 matrix)
  // 3. Initialize camera illumination LED
  // 4. Initialize Wi-Fi (load credentials from NVS, connect or start AP mode)
  // 5. Load configuration from NVS/flash
  // 6. Configure interrupts (PIR motion detection)
  // 7. Run self-test (verify all hardware)
  // 8. Send device/status to Pi over serial
  // 9. Enter idle state (OTA checks run hourly in loop)
}

void loop() {
  // State machine execution
  switch(currentState) {
    case STATE_IDLE:
      // Deep sleep, wake on PIR interrupt
      enterDeepSleep();
      break;
    
    case STATE_WAKE:
      // Turn on LEDs, initialize camera
      initializeWakeMode();
      currentState = STATE_ACTIVE;
      break;
    
    case STATE_ACTIVE:
      // Monitor for keyword detection
      // Check for OTA updates (hourly)
      // Check for timeout
      if (microphoneHasData()) {
        checkForKeyword();
      }
      if (wifiConnected && millis() - lastOTACheck > OTA_CHECK_INTERVAL) {
        checkForUpdates();  // Sends device/ota-check via serial
        lastOTACheck = millis();
      }
      if (millis() - lastActivityTime > WAKE_TIMEOUT) {
        shutdownWakeMode();
        currentState = STATE_IDLE;
      }
      break;
    
    case STATE_LISTENING:
      // Record audio buffer
      // Send to transcription service
      recordAndTranscribeAudio();
      currentState = STATE_PROCESSING;
      break;
    
    case STATE_PROCESSING:
      // Wait for API response (with timeout)
      // Parse response
      if (apiResponseReady()) {
        processToolRequest();
        currentState = STATE_INDICATING;
      }
      break;
    
    case STATE_INDICATING:
      // Display LED feedback
      // Wait for timeout or user interaction
      updateDrawerLEDs();
      if (feedbackComplete()) {
        currentState = STATE_ACTIVE;
      }
      break;
    
    case STATE_SCANNING:
      // Capture image of drawer
      // Send to API for identification
      captureAndIdentifyTool();
      currentState = STATE_ACTIVE;
      break;
    
    case STATE_ERROR:
      // Flash error code
      // Log to serial
      // Wait for reset or timeout recovery
      handleError();
      break;
  }
  
  // Reset activity timer on any interaction
  if (motionDetected() || drawerEventDetected()) {
    lastActivityTime = millis();
  }
}
```
