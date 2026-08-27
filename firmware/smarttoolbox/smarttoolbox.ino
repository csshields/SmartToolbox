/**
 * SmartToolbox - Seeed XIAO ESP32S3 Firmware
 *
 * Touching a mapped pad sends a tools/lookup request to the Pi over USB
 * serial and reports the result three ways: the onboard LED blinks N slow for
 * the row number, 3 fast for not found, 1 long for error or timeout; the OLED
 * names the tool and its exact drawer label; and the 8x8 matrix lights the
 * matching row, showing idle "eyes" the rest of the time.
 *
 * The matrix is NOT WIRED YET. Its code is inert until the VID check passes,
 * and none of it has run on hardware - see docs/PLAN-matrix-eyes.md.
 */

#include <ArduinoJson.h>
#include <Wire.h>
#include <U8g2lib.h>
#include "grove_two_rgb_led_matrix.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <Update.h>
#include "arduino_secrets.h"

// Single source of truth for the version this build reports. Rewritten by
// api/scripts/release-firmware.ps1 on release, and compared against the Pi's
// drop folder to decide whether an OTA update is available - keep the exact
// `#define FIRMWARE_VERSION "x.y.z"` shape so the script can find it.
#define FIRMWARE_VERSION "0.5.0"

const int LED_PIN = LED_BUILTIN; // Active-low: LOW = on, HIGH = off.
const int LED_ON = LOW;
const int LED_OFF = HIGH;

// Grove SSD1315 0.96" on the I2C connector. The SSD1315 is SSD1306-compatible,
// so the NONAME constructor drives it - same one the PIR bring-up sketch used.
U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);
bool oledReady = false;

// Grove 8x8 RGB matrix, on the same I2C bus. NOT WIRED YET - matrixReady stays
// false and every matrix call below returns early, so the box behaves exactly
// as it does without one. None of this is hardware-verified; see
// docs/PLAN-matrix-eyes.md for what to check on first power-up.
GroveTwoRGBLedMatrixClass matrix;
bool matrixReady = false;

// One byte per pixel, and the byte is a palette index rather than RGB. Note
// black is 0xFF: clearing this buffer with zeroes lights the whole panel red.
const uint8_t MATRIX_WIDTH = 8;
const uint8_t MATRIX_HEIGHT = 8;
uint8_t matrixFrame[MATRIX_WIDTH * MATRIX_HEIGHT];
bool matrixFrameDirty = false;

// Toolbox row N lights matrix row y = N, leaving y=0 and y=7 as blank margins so
// the six indicators sit centred. Six positions for eight rows is the spec's
// Physical Layout rule: row 1 is one shared indicator for drawers 1A/1B/1C.
const uint8_t MATRIX_FIRST_ROW_Y = 1;
const uint8_t MATRIX_LAST_ROW_Y = 6;

// GPIO5/GPIO6 are deliberately absent: they are the I2C bus (SDA/SCL) the OLED
// runs on, so touch-reading them would fight the display.
const uint8_t TOUCH_PINS[] = {1, 2, 3, 4, 7, 8, 9};
const size_t TOUCH_PIN_COUNT = sizeof(TOUCH_PINS) / sizeof(TOUCH_PINS[0]);
uint32_t touchBaseline[TOUCH_PIN_COUNT];

// The S3's touch peripheral (sensor v2) reads *higher* when a pad is touched -
// the opposite of the original ESP32. See esp32-hal-touch.h in the core.
// Tune this ratio against the TOUCH_DEBUG output if a pad misses or false-fires.
const float TOUCH_TRIGGER_RATIO = 1.15f;

// Prints per-scan touch readings so the ratio above can be tuned on hardware.
// Off now that D0 is trusted: at ~3 lines/second these drowned the Pi's log,
// where the only interesting entries are real requests. Turn it back on when
// bringing up a new pad, then turn it off again.
#define TOUCH_DEBUG 0

// Parallel to TOUCH_PINS. Only pad D0 is mapped for now; add entries as more
// tools are seeded. Unmapped pads are never scanned.
const char* TOUCH_TOOL_NAMES[TOUCH_PIN_COUNT] = {
  "Phillips Screwdriver", nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
};

const uint16_t RESPONSE_TIMEOUT_MS = 2000;

// Wi-Fi is used for OTA updates only, and only during setup(). USB serial stays
// the link for everything else, so the radio is switched off before loop() runs
// rather than left associated for the device's whole uptime.
#define OTA_ENABLED 1
const char* PI_HOST = "192.168.50.30";
const uint16_t PI_PORT = 3000;
const uint32_t WIFI_CONNECT_TIMEOUT_MS = 25000;

uint8_t consecutiveTouched = 0;
uint8_t consecutiveReleased = 0;
bool wasTouched = false;

String serialLineBuffer = "";
String pendingRequestId = "";
String pendingToolName = ""; // Kept so the OLED can name the tool in the result.
bool awaitingResponse = false;
uint32_t pendingSince = 0;
uint32_t requestCounter = 0;

uint8_t blinkRemaining = 0;
uint16_t blinkOnMs = 0;
uint16_t blinkOffMs = 0;
bool blinkLedOn = false;
uint32_t blinkPhaseStart = 0;

// --- Matrix -----------------------------------------------------------------
// The idle face and a lookup result are mutually exclusive, so they can share
// pixels. Results are what the box is for; the face is what it does the rest of
// the time.
enum MatrixMode { MATRIX_EYES, MATRIX_RESULT };

MatrixMode matrixMode = MATRIX_EYES;
uint32_t matrixResultUntil = 0;
uint32_t matrixNextBlinkAt = 0;
uint32_t matrixEyesClosedUntil = 0;
bool matrixEyesClosed = false;

const uint16_t MATRIX_RESULT_HOLD_MS = 4000;
const uint16_t MATRIX_BLINK_CLOSED_MS = 130;

void matrixClear() {
  memset(matrixFrame, black, sizeof(matrixFrame));
  matrixFrameDirty = true;
}

void matrixSetPixel(uint8_t x, uint8_t y, uint8_t color) {
  if (x >= MATRIX_WIDTH || y >= MATRIX_HEIGHT) {
    return;
  }
  const size_t index = (size_t)y * MATRIX_WIDTH + x;
  if (matrixFrame[index] != color) {
    matrixFrame[index] = color;
    matrixFrameDirty = true;
  }
}

void matrixFillRow(uint8_t y, uint8_t color) {
  for (uint8_t x = 0; x < MATRIX_WIDTH; x++) {
    matrixSetPixel(x, y, color);
  }
}

// forever_flag keeps the panel showing the frame without further writes, so this
// only needs to run when something actually changed.
void matrixPush() {
  if (!matrixReady || !matrixFrameDirty) {
    return;
  }
  matrix.displayFrames(matrixFrame, 1000, true, 1);
  matrixFrameDirty = false;
}

void drawEyes(bool closed) {
  matrixClear();

  // Two 2x2 eyes; a blink collapses each to its lower row so it reads as a lid
  // coming down rather than the display simply switching off.
  const uint8_t eyeColumns[] = {1, 5};
  for (uint8_t eye = 0; eye < 2; eye++) {
    const uint8_t x = eyeColumns[eye];
    if (!closed) {
      matrixSetPixel(x, 2, cyan);
      matrixSetPixel(x + 1, 2, cyan);
    }
    matrixSetPixel(x, 3, cyan);
    matrixSetPixel(x + 1, 3, cyan);
  }
}

void scheduleNextBlink() {
  matrixNextBlinkAt = millis() + random(2000, 6000);
}

// Certainty is null for any tool the camera has never seen, which is currently
// every tool in the box - so null gets its own colour rather than a fallback.
uint8_t certaintyColor(bool hasCertainty, int certainty) {
  if (!hasCertainty) {
    return white;
  }
  return certainty >= 75 ? green : orange;
}

void showMatrixRow(int rowNumber, bool hasCertainty, int certainty) {
  matrixClear();
  const uint8_t y = (uint8_t)rowNumber;
  if (y >= MATRIX_FIRST_ROW_Y && y <= MATRIX_LAST_ROW_Y) {
    matrixFillRow(y, certaintyColor(hasCertainty, certainty));
  }
  matrixMode = MATRIX_RESULT;
  matrixResultUntil = millis() + MATRIX_RESULT_HOLD_MS;
  matrixPush();
}

void showMatrixAlert(uint8_t color) {
  matrixClear();
  for (uint8_t y = MATRIX_FIRST_ROW_Y; y <= MATRIX_LAST_ROW_Y; y++) {
    matrixFillRow(y, color);
  }
  matrixMode = MATRIX_RESULT;
  matrixResultUntil = millis() + MATRIX_RESULT_HOLD_MS;
  matrixPush();
}

void updateMatrix() {
  if (!matrixReady) {
    return;
  }

  if (matrixMode == MATRIX_RESULT) {
    if (millis() >= matrixResultUntil) {
      matrixMode = MATRIX_EYES;
      matrixEyesClosed = false;
      drawEyes(false);
      // Reset the timer on the way back so the face does not blink the instant
      // it returns.
      scheduleNextBlink();
      matrixPush();
    }
    return;
  }

  if (matrixEyesClosed) {
    if (millis() >= matrixEyesClosedUntil) {
      matrixEyesClosed = false;
      drawEyes(false);
      scheduleNextBlink();
    }
  } else if (millis() >= matrixNextBlinkAt) {
    matrixEyesClosed = true;
    matrixEyesClosedUntil = millis() + MATRIX_BLINK_CLOSED_MS;
    drawEyes(true);
  }

  matrixPush();
}

// Called only on state changes: a full 1KB buffer push over I2C costs ~10ms,
// which would starve the serial poll if it ran every loop.
void showStatus(const char* title, const String& line2, const String& line3) {
  if (!oledReady) {
    return;
  }
  oled.clearBuffer();
  oled.setFont(u8g2_font_6x12_tr);
  oled.drawStr(0, 12, title);
  oled.drawUTF8(0, 30, line2.c_str());
  oled.drawUTF8(0, 46, line3.c_str());
  oled.sendBuffer();
}

#if OTA_ENABLED
// Returns true only when an update was written and the device is about to
// reboot into it. Every failure path returns false and leaves the running
// firmware untouched: the ESP32 writes to the inactive OTA slot and only marks
// it bootable after Update.end() verifies the image, so a refused, corrupted,
// or interrupted download costs a boot delay, not the device.
bool checkForFirmwareUpdate() {
  if (strlen(SECRET_SSID) == 0) {
    return false; // No credentials configured - not an error, just nothing to do.
  }

  showStatus("Update check", "Joining Wi-Fi", SECRET_SSID);

  // Plain-text OTA progress on the protocol wire. The Pi ignores lines that are
  // not JSON and logs them as [serial-debug], and without this the whole update
  // path is only observable on a 128x64 screen.
  Serial.print("OTA joining SSID=");
  Serial.println(SECRET_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false, true); // Clear any stored association before scanning.
  delay(100);

  // Scan before connecting: an SSID that does not appear here is either 5GHz
  // (invisible to this radio), out of range, or spelled differently than the
  // secrets file thinks. That distinction is invisible from the status code.
  const int found = WiFi.scanNetworks();
  Serial.print("OTA scan found ");
  Serial.println(found);
  for (int i = 0; i < found; i++) {
    Serial.print("OTA   ssid=\"");
    Serial.print(WiFi.SSID(i));
    Serial.print("\" rssi=");
    Serial.print(WiFi.RSSI(i));
    Serial.print(" ch=");
    Serial.print(WiFi.channel(i));
    Serial.print(" enc=");
    Serial.println(WiFi.encryptionType(i));
  }
  WiFi.scanDelete();

  // Re-issue begin() rather than waiting out one attempt. A single association
  // that stalls in WL_IDLE_STATUS never recovers on its own, and on a weak link
  // the first attempt frequently does exactly that.
  const uint32_t startedAt = millis();
  uint32_t lastAttempt = 0;
  int attempts = 0;

  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < WIFI_CONNECT_TIMEOUT_MS) {
    if (lastAttempt == 0 || millis() - lastAttempt > 5000) {
      attempts++;
      Serial.print("OTA connect attempt ");
      Serial.print(attempts);
      Serial.print(" status=");
      Serial.println(WiFi.status());
      WiFi.begin(SECRET_SSID, SECRET_OPTIONAL_PASS);
      lastAttempt = millis();
    }
    delay(200);
  }

  if (WiFi.status() != WL_CONNECTED) {
    // Status codes: 1=no SSID found, 4=connect failed (usually a bad password),
    // 6=disconnected. 1 with a correct name normally means the radio cannot see
    // the network at all - the XIAO is 2.4GHz only.
    Serial.print("OTA wifi failed status=");
    Serial.print(WiFi.status());
    Serial.print(" visible networks=");
    Serial.println(found); // Reuse the scan above; rescanning here costs seconds.

    showStatus("Update check", "No Wi-Fi", "status " + String(WiFi.status()));
    WiFi.disconnect(true, true);
    WiFi.mode(WIFI_OFF);
    delay(1500);
    return false;
  }

  Serial.print("OTA wifi ok ip=");
  Serial.println(WiFi.localIP());

  HTTPClient http;
  String url = "http://" + String(PI_HOST) + ":" + String(PI_PORT) +
               "/api/firmware/latest?currentVersion=" + FIRMWARE_VERSION;

  http.begin(url);
  http.addHeader("X-Device-Key", SECRET_DEVICE_KEY);

  // HTTPClient discards response headers unless they are requested up front.
  const char* wantedHeaders[] = {"X-Firmware-Version"};
  http.collectHeaders(wantedHeaders, 1);

  const int status = http.GET();

  Serial.print("OTA GET ");
  Serial.print(url);
  Serial.print(" -> ");
  Serial.println(status);

  if (status == 204) {
    showStatus("Up to date", "v" FIRMWARE_VERSION, "");
    http.end();
    WiFi.disconnect(true, true);
    WiFi.mode(WIFI_OFF);
    return false;
  }

  if (status != 200) {
    // 401 means the device key disagrees with the Pi; 503 means the Pi has no
    // key configured. Both are worth showing rather than silently skipping.
    showStatus("Update failed", "HTTP " + String(status), "");
    http.end();
    WiFi.disconnect(true, true);
    WiFi.mode(WIFI_OFF);
    delay(2000);
    return false;
  }

  const int contentLength = http.getSize();
  const String newVersion = http.header("X-Firmware-Version");

  if (contentLength <= 0 || !Update.begin(contentLength)) {
    showStatus("Update failed", "No space", String(contentLength));
    http.end();
    WiFi.disconnect(true, true);
    WiFi.mode(WIFI_OFF);
    delay(2000);
    return false;
  }

  showStatus("Updating", "v" FIRMWARE_VERSION " -> " + newVersion, "0%");

  Update.onProgress([](size_t done, size_t total) {
    // Redrawing on every chunk would spend more time on I2C than on the flash
    // write, so only redraw when the whole-number percentage changes.
    static int lastPercent = -1;
    const int percent = total > 0 ? (int)((done * 100) / total) : 0;
    if (percent != lastPercent) {
      lastPercent = percent;
      showStatus("Updating", "Writing image", String(percent) + "%");
    }
  });

  Serial.print("OTA writing ");
  Serial.print(contentLength);
  Serial.print(" bytes for v");
  Serial.println(newVersion);

  const size_t written = Update.writeStream(http.getStream());
  http.end();

  Serial.print("OTA wrote ");
  Serial.println(written);

  if (written != (size_t)contentLength || !Update.end(true)) {
    Serial.print("OTA failed: ");
    Serial.println(Update.errorString());
    showStatus("Update failed", "Keeping v" FIRMWARE_VERSION, String(Update.errorString()));
    Update.abort();
    WiFi.disconnect(true, true);
    WiFi.mode(WIFI_OFF);
    delay(3000);
    return false;
  }

  showStatus("Updated", "Now v" + newVersion, "Rebooting");
  delay(1500);
  WiFi.disconnect(true, true);
  ESP.restart();
  return true; // Not reached - restart() does not return.
}
#endif

void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LED_OFF);

  Serial.begin(115200);
  // Bounded: the XIAO is often powered up before the Pi service opens the port,
  // and an unbounded wait here would hang the sketch before setup() finishes.
  const uint32_t serialWaitStart = millis();
  while (!Serial && millis() - serialWaitStart < 3000) {
    delay(10);
  }
  delay(200);

  Wire.begin();
  oledReady = oled.begin();
  showStatus("SmartToolbox", "Starting up", "v" FIRMWARE_VERSION);

  // Presence check before the OTA block, so the face is up during the update
  // check rather than leaving the panel undefined for the Wi-Fi timeout.
  matrix.scanGroveTwoRGBLedMatrixI2CAddress();
  matrixReady = matrix.getDeviceVID() == GROVE_TWO_RGB_LED_MATRIX_VID;
  Serial.print("Matrix ready=");
  Serial.println(matrixReady ? 1 : 0);

  if (matrixReady) {
    matrix.stopDisplay();
    randomSeed(esp_random()); // Blink intervals are randomised; without this every boot blinks identically.
    drawEyes(false);
    scheduleNextBlink();
    matrixPush();
  }

#if OTA_ENABLED
  // Before touch calibration: if an update is waiting there is no point
  // spending half a second calibrating pads we are about to reboot away from.
  checkForFirmwareUpdate();
#endif

  showStatus("SmartToolbox", "Starting up", "Calibrating touch");

  for (size_t pinIndex = 0; pinIndex < TOUCH_PIN_COUNT; pinIndex++) {
    if (TOUCH_TOOL_NAMES[pinIndex] == nullptr) {
      continue; // Unmapped pad - never scanned, so never needs a baseline.
    }
    // The first reads after boot come back roughly 8x high while the touch
    // peripheral settles. Discard them, or the baseline lands far above any
    // value a real touch can reach and the pad goes permanently dead.
    for (int warmUp = 0; warmUp < 10; warmUp++) {
      touchRead(TOUCH_PINS[pinIndex]);
      delay(2);
    }

    uint32_t total = 0;
    for (int sample = 0; sample < 20; sample++) {
      total += touchRead(TOUCH_PINS[pinIndex]);
      delay(2);
    }
    touchBaseline[pinIndex] = total / 20;
  }

  Serial.println("{\"id\":\"boot-1\",\"type\":\"request\",\"endpoint\":\"device/status\",\"body\":{\"firmwareVersion\":\"" FIRMWARE_VERSION "\"}}");

  showStatus("SmartToolbox", "Ready", "Touch a pad");
}

void loop() {
  pollTouch();
  pollSerialResponses();
  pollResponseTimeout();
  updateBlinkPlan();
  updateMatrix();
}

uint32_t lastTouchScanValue0 = 0; // Shared with the debug print below - no extra reads.

void debugPrintTouchD0() {
#if TOUCH_DEBUG
  static uint32_t lastPrint = 0;
  if (millis() - lastPrint < 300) {
    return;
  }
  lastPrint = millis();
  Serial.print("DBG D0 value=");
  Serial.print(lastTouchScanValue0);
  Serial.print(" baseline=");
  Serial.print(touchBaseline[0]);
  Serial.print(" trigger-above=");
  Serial.println((uint32_t)(touchBaseline[0] * TOUCH_TRIGGER_RATIO));
#endif
}

// The scan is throttled to ~50ms - the ESP32-S3 touch peripheral times
// out ("Wait for measurement done timeout") if polled with no gap at all.
void pollTouch() {
  static uint32_t lastScan = 0;
  if (millis() - lastScan < 50) {
    return;
  }
  lastScan = millis();

  bool touched = false;
  int touchedPinIndex = -1;

  for (size_t pinIndex = 0; pinIndex < TOUCH_PIN_COUNT; pinIndex++) {
    // Skip unmapped pads. Beyond saving work, reading every pad back-to-back
    // with no gap makes the S3 touch peripheral return a frozen garbage value.
    if (TOUCH_TOOL_NAMES[pinIndex] == nullptr) {
      continue;
    }
    const uint32_t touchValue = touchRead(TOUCH_PINS[pinIndex]);
    if (pinIndex == 0) {
      lastTouchScanValue0 = touchValue;
    }
    if (touchValue > touchBaseline[pinIndex] * TOUCH_TRIGGER_RATIO) {
      touched = true;
      touchedPinIndex = pinIndex;
      break;
    }
  }

  debugPrintTouchD0();

  if (touched) {
    consecutiveTouched++;
    consecutiveReleased = 0;
  } else {
    consecutiveTouched = 0;
    consecutiveReleased++;
  }

  // Debounce both edges. Press needs 2 consecutive readings; release needs 2 as
  // well, so a single noisy sub-threshold sample mid-touch cannot end the press
  // and re-arm the next one.
  const bool isTouched = wasTouched ? consecutiveReleased < 2 : consecutiveTouched >= 2;
  if (isTouched && !wasTouched) {
    onTouchStart(touchedPinIndex);
  }
  wasTouched = isTouched;
}

// Only start a new lookup when idle - not already waiting on one or blinking its result.
void onTouchStart(int pinIndex) {
  if (pinIndex < 0 || awaitingResponse || blinkRemaining > 0) {
    return;
  }

  const char* toolName = TOUCH_TOOL_NAMES[pinIndex];
  if (toolName == nullptr) {
    return;
  }

  sendToolLookupRequest(toolName);
}

void sendToolLookupRequest(const char* toolName) {
  requestCounter++;
  char idBuffer[16];
  snprintf(idBuffer, sizeof(idBuffer), "req-%lu", (unsigned long)requestCounter);

  JsonDocument doc;
  doc["id"] = idBuffer;
  doc["type"] = "request";
  doc["endpoint"] = "tools/lookup";
  doc["body"]["query"] = toolName;

  serializeJson(doc, Serial);
  Serial.print('\n');

  pendingRequestId = idBuffer;
  pendingToolName = toolName;
  pendingSince = millis();
  awaitingResponse = true;

  showStatus("Looking up", pendingToolName, "");
}

void pollSerialResponses() {
  while (Serial.available() > 0) {
    const char incomingChar = (char)Serial.read();
    if (incomingChar == '\n') {
      handleIncomingLine(serialLineBuffer);
      serialLineBuffer = "";
    } else if (incomingChar != '\r') {
      serialLineBuffer += incomingChar;
    }
  }
}

void handleIncomingLine(const String& line) {
  if (line.length() == 0) {
    return;
  }

  // Bench trigger: "lookup <tool name>" typed into a serial monitor runs the same
  // request path as a touch, so the Pi round trip can be proven without the pads.
  // The Pi only ever writes JSON here, so this cannot collide with a response.
  if (line.startsWith("lookup ")) {
    if (!awaitingResponse && blinkRemaining == 0) {
      sendToolLookupRequest(line.substring(7).c_str());
    }
    return;
  }

  if (!awaitingResponse) {
    return;
  }

  JsonDocument doc;
  if (deserializeJson(doc, line) != DeserializationError::Ok) {
    return;
  }

  const char* responseId = doc["id"] | "";
  if (pendingRequestId != responseId) {
    return; // Not the response we're waiting on - ignore.
  }

  awaitingResponse = false;

  const bool success = doc["success"] | false;
  if (!success) {
    showStatus("Error", pendingToolName, doc["error"]["code"] | "lookup failed");
    startBlinkPlan(1, 1000, 1000); // Long blink: error.
    showMatrixAlert(red);
    return;
  }

  const bool found = doc["body"]["found"] | false;
  if (!found) {
    showStatus("Not found", pendingToolName, "");
    startBlinkPlan(3, 150, 150); // Fast blinks: not found.
    showMatrixAlert(red);
    return;
  }

  const int rowNumber = doc["body"]["rows"][0]["rowNumber"] | 0;

  // The row number is all the LED (and eventually the 8x8 matrix) can convey.
  // The drawer label is the half only the OLED can show - see Physical Layout
  // in the spec, where row 1 spans drawers 1A/1B/1C.
  const char* drawerLabel = doc["body"]["drawers"][0]["label"] | "";
  showStatus("Found", pendingToolName, "Row " + String(rowNumber) + "  Drawer " + drawerLabel);

  // certainty is null for a tool the camera has never observed - distinguish
  // "no reading" from a low reading rather than collapsing both to a number.
  JsonVariant certainty = doc["body"]["rows"][0]["certainty"];
  showMatrixRow(rowNumber, !certainty.isNull(), certainty | 0);

  if (rowNumber > 0) {
    startBlinkPlan(rowNumber, 500, 500); // Slow blinks: row number.
  } else {
    // Found, but in a drawer with no row assigned. Falling back to one slow
    // blink would be told apart from the error's single long blink only by its
    // duration, so use the not-found pattern instead: the LED cannot express
    // "somewhere unknown", and the OLED is already showing the drawer label.
    startBlinkPlan(3, 150, 150);
  }
}

void pollResponseTimeout() {
  if (awaitingResponse && millis() - pendingSince > RESPONSE_TIMEOUT_MS) {
    awaitingResponse = false;
    showStatus("No response", pendingToolName, "Is the Pi service up?");
    startBlinkPlan(1, 1000, 1000); // Long blink: timeout.
    showMatrixAlert(red);
  }
}

void startBlinkPlan(uint8_t count, uint16_t onMs, uint16_t offMs) {
  blinkRemaining = count;
  blinkOnMs = onMs;
  blinkOffMs = offMs;
  blinkLedOn = true;
  blinkPhaseStart = millis();
  digitalWrite(LED_PIN, LED_ON);
}

void updateBlinkPlan() {
  if (blinkRemaining == 0) {
    return;
  }

  const uint32_t elapsed = millis() - blinkPhaseStart;
  if (blinkLedOn && elapsed >= blinkOnMs) {
    digitalWrite(LED_PIN, LED_OFF);
    blinkLedOn = false;
    blinkPhaseStart = millis();
  } else if (!blinkLedOn && elapsed >= blinkOffMs) {
    blinkRemaining--;
    if (blinkRemaining == 0) {
      return;
    }
    digitalWrite(LED_PIN, LED_ON);
    blinkLedOn = true;
    blinkPhaseStart = millis();
  }
}

