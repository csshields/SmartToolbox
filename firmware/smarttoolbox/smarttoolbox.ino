/**
 * SmartToolbox - Seeed XIAO ESP32S3 Firmware
 *
 * Touching a mapped pad sends a tools/lookup request to the Pi over USB
 * serial and reports the result two ways: the onboard LED blinks N slow for
 * the row number, 3 fast for not found, 1 long for error or timeout, and the
 * OLED names the tool and its exact drawer label. The 8x8 matrix is not wired
 * yet, so the LED stands in for the row indicator.
 */

#include <ArduinoJson.h>
#include <Wire.h>
#include <U8g2lib.h>

// Single source of truth for the version this build reports. Rewritten by
// api/scripts/release-firmware.ps1 on release, and compared against the Pi's
// drop folder to decide whether an OTA update is available - keep the exact
// `#define FIRMWARE_VERSION "x.y.z"` shape so the script can find it.
#define FIRMWARE_VERSION "0.3.0"

const int LED_PIN = LED_BUILTIN; // Active-low: LOW = on, HIGH = off.
const int LED_ON = LOW;
const int LED_OFF = HIGH;

// Grove SSD1315 0.96" on the I2C connector. The SSD1315 is SSD1306-compatible,
// so the NONAME constructor drives it - same one the PIR bring-up sketch used.
U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);
bool oledReady = false;

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
// Set to 0 once the pads are trusted - the API tolerates these lines but they
// still share the wire with the protocol.
#define TOUCH_DEBUG 1

// Parallel to TOUCH_PINS. Only pad D0 is mapped for now; add entries as more
// tools are seeded. Unmapped pads are never scanned.
const char* TOUCH_TOOL_NAMES[TOUCH_PIN_COUNT] = {
  "Phillips Screwdriver", nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
};

const uint16_t RESPONSE_TIMEOUT_MS = 2000;

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

  const bool isTouched = consecutiveTouched >= 2;
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
    return;
  }

  const bool found = doc["body"]["found"] | false;
  if (!found) {
    showStatus("Not found", pendingToolName, "");
    startBlinkPlan(3, 150, 150); // Fast blinks: not found.
    return;
  }

  const int rowNumber = doc["body"]["rows"][0]["rowNumber"] | 0;

  // The row number is all the LED (and eventually the 8x8 matrix) can convey.
  // The drawer label is the half only the OLED can show - see Physical Layout
  // in the spec, where row 1 spans drawers 1A/1B/1C.
  const char* drawerLabel = doc["body"]["drawers"][0]["label"] | "";
  showStatus("Found", pendingToolName, "Row " + String(rowNumber) + "  Drawer " + drawerLabel);

  startBlinkPlan(rowNumber > 0 ? rowNumber : 1, 500, 500); // Slow blinks: row number.
}

void pollResponseTimeout() {
  if (awaitingResponse && millis() - pendingSince > RESPONSE_TIMEOUT_MS) {
    awaitingResponse = false;
    showStatus("No response", pendingToolName, "Is the Pi service up?");
    startBlinkPlan(1, 1000, 1000); // Long blink: timeout.
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

