/**
 * SmartToolbox - Seeed XIAO ESP32S3 Firmware
 *
 * Touching a mapped pad sends a tools/lookup request to the Pi over USB
 * serial and reports the result three ways: the onboard LED blinks N slow for
 * the row number, 3 fast for not found, 1 long for error or timeout; the OLED
 * names the tool and its exact drawer label; and the 8x8 matrix lights the
 * matching row, showing idle "eyes" the rest of the time.
 *
 * The matrix is wired and detected. Its code stays inert until the VID check
 * passes, so a box without one behaves exactly as it did before.
 */

#include <ArduinoJson.h>
#include <Wire.h>
#include <U8g2lib.h>
#include "grove_two_rgb_led_matrix.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <Update.h>
#include <ESP_I2S.h>
#include "arduino_secrets.h"

// Single source of truth for the version this build reports. Rewritten by
// api/scripts/release-firmware.ps1 on release, and compared against the Pi's
// drop folder to decide whether an OTA update is available - keep the exact
// `#define FIRMWARE_VERSION "x.y.z"` shape so the script can find it.
#define FIRMWARE_VERSION "0.21.0"

const int LED_PIN = LED_BUILTIN; // Active-low: LOW = on, HIGH = off.
const int LED_ON = LOW;
const int LED_OFF = HIGH;

// Grove SSD1315 0.96" on the I2C connector. The SSD1315 is SSD1306-compatible,
// so the NONAME constructor drives it - same one the PIR bring-up sketch used.
U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);
bool oledReady = false;

// Grove 8x8 RGB matrix, on the same I2C bus. matrixReady comes from the VID
// check, and every matrix call returns early without it, so a box with no matrix
// attached behaves exactly as it did before this existed.
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

// Orientation is stored on the matrix itself and survives power cycles, so
// without setting it explicitly the panel renders at whatever rotation it was
// last left in - which differs between boards and after any stray write. Set it
// every boot so "row 1" always means the same physical row. Rotate this if the
// eyes and the row indicator do not sit the way up the built-in displayNumber()
// output does.
const orientation_type_t MATRIX_ORIENTATION = DISPLAY_ROTATE_270;

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

// Transcription is not a lookup and cannot share its timeout. Measured against
// the NAS on 2026-08-29: ~9.3s for one second of audio once warm, and well over
// 30s on the first call after the container has been idle and has to load the
// model. The Pi gives up at 90s; this is deliberately longer, so the device is
// never the one to abandon a request the Pi is still working on.
const uint32_t VOICE_TIMEOUT_MS = 100000;
bool pendingIsVoice = false;

// Wi-Fi is used for OTA updates only, and only during setup(). USB serial stays
// the link for everything else, so the radio is switched off before loop() runs
// rather than left associated for the device's whole uptime.
#define OTA_ENABLED 1
const char* PI_HOST = "192.168.50.30";
const uint16_t PI_PORT = 3000;
const uint32_t WIFI_CONNECT_TIMEOUT_MS = 25000;

// Thirty seconds is a compromise: often enough that the dashboard reads as live
// and a reboot is noticed promptly, rare enough that it is not worth writing
// every one of them to the request log.
const uint32_t DEVICE_STATUS_INTERVAL_MS = 30000;
uint32_t nextDeviceStatusAt = 0;
unsigned long statusCounter = 0;

// --- Startup readiness -------------------------------------------------------
//
// Both halves of the box boot from the same power and do not arrive together:
// this device is up in seconds, the Pi takes 36.6s (5.2s kernel + 31.4s
// userspace) before its API accepts anything. For that whole window the box
// used to say "Ready" and mean nothing by it - a touch went into a void and
// came back "No response - Is the Pi service up?", which is a question the
// device is not entitled to ask while the Pi is merely booting.
//
// So the fast half waits. Nothing here changes on the Pi: there is nothing it
// can do about a 31-second userspace, and a device that copes is worth more
// than a server that hurries. See docs/PLAN-startup-readiness.md.
bool deviceReady = false;

// Far more frequent than the 30s heartbeat on purpose: this window is ~35
// seconds long, and a 30-second poll would spend most of it asleep.
const uint32_t WAITING_RETRY_MS = 2000;
uint32_t nextWaitingRetryAt = 0;

// There is no timeout that gives up - a Pi that takes five minutes gets waited
// for. But 90 seconds is well past anything a healthy boot has ever taken, so
// past that the face stops pretending this is normal. It is a change of
// expression, not a failure state: the retry continues either way.
const uint32_t WAITING_LONG_MS = 90000;
uint32_t waitingSince = 0;
bool waitingLong = false;

// The boot check alone let three releases go by unnoticed: the device only
// looked for an update in the first seconds after power-on, so a box that
// stayed up never learned a new version existed. Re-checking on an interval is
// what makes a release actually reach a running device.
//
// Thirty minutes, and only while idle. The check costs up to
// WIFI_CONNECT_TIMEOUT_MS of blocked loop when the radio cannot associate, so
// it must never land in the middle of a lookup the user is waiting on.
const uint32_t FIRMWARE_CHECK_INTERVAL_MS = 30UL * 60UL * 1000UL;

// The boot check cannot succeed when the whole box is powered on at once, and
// this is measured rather than suspected: the Pi takes 36.6s to finish booting
// (5.2s kernel + 31.4s userspace) before its API accepts anything, while this
// device starts asking ~3.5s in and gives up after the 25s Wi-Fi timeout, at
// roughly 30s. It loses by about ten seconds, every time, by construction.
//
// So the first re-check is deliberately soon rather than a full interval: by
// two minutes the Pi is up with a wide margin. Updates used to work only
// because the XIAO was being reset by itself against an already-running Pi.
const uint32_t FIRMWARE_FIRST_CHECK_MS = 2UL * 60UL * 1000UL;
uint32_t nextFirmwareCheckAt = 0;

// What the last update check actually did. Kept because the check runs before
// the Pi has opened the port: on the S3's native USB CDC, anything printed
// while no host is attached is discarded, so the boot-time OTA log is lost
// every time. Holding the outcome and printing it once the link is up is the
// difference between a diagnosable failure and silence.
String lastOtaResult = "not checked";
bool lastOtaResultReported = false;

// --- Microphone (PDM, on the XIAO Sense expansion board) ---------------------
//
// Bring-up only. With MIC_BRINGUP set, pad D0 records a fixed clip and prints
// statistics instead of running a tool lookup - see docs/PLAN-mic-bringup.md
// Step 1. The point is a number that separates "no data", "wrong pins", and
// "working", three failures that are otherwise identical from the outside.
// Set this back to 0 to get the lookup pad behaviour back.
#define MIC_BRINGUP 1

// Fixed by the Sense board's board-to-board connector - not free choices.
const int8_t MIC_CLOCK_PIN = 42;
const int8_t MIC_DATA_PIN = 41;

// None of these three are choices either: the ESP32-S3 supports PDM only as
// 16-bit mono, and 16 kHz is both what Seeed reports as stable and the rate
// Whisper wants, so resampling never enters the picture.
const uint32_t MIC_SAMPLE_RATE = 16000;
const uint8_t MIC_BYTES_PER_SAMPLE = 2;
// Hold-to-talk. The length is not known when recording starts, so the buffer is
// allocated at the cap and only the filled part is sent.
//
// 300ms floor: below that it is a brush against the pad rather than a word, and
// Whisper on a fragment that short returns confident nonsense - which is worse
// than nothing, because it looks like an answer. 10s ceiling: it bounds this
// allocation, and it is what the Pi's own cap agrees with.
const uint32_t MIC_MIN_HOLD_MS = 300;
const uint32_t MIC_MAX_HOLD_MS = 10000;
const size_t MIC_MAX_BYTES = (size_t)MIC_SAMPLE_RATE * MIC_BYTES_PER_SAMPLE * (MIC_MAX_HOLD_MS / 1000);

// Read in ~100ms pieces rather than one blocking gulp. Two things need this:
// the wave cannot animate during a read that does not return, and hold-to-talk
// cannot notice the pad being released either. A single readBytes for the whole
// recording made both impossible.
const size_t MIC_CHUNK_BYTES = (size_t)MIC_SAMPLE_RATE * MIC_BYTES_PER_SAMPLE / 10;

I2SClass mic;
bool micReady = false;

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
// A lookup used to end three different ways and look identical doing it: a red
// band meant "not in any drawer", "the Pi could not make sense of the request",
// and "the Pi never answered". Each has its own picture now, and the wait before
// them has one too.
enum MatrixMode { MATRIX_WAITING, MATRIX_EYES, MATRIX_THINKING, MATRIX_RESULT };

MatrixMode matrixMode = MATRIX_EYES;
uint32_t matrixResultUntil = 0;
uint32_t matrixNextBlinkAt = 0;
uint32_t matrixEyesClosedUntil = 0;
bool matrixEyesClosed = false;

// A result shows in two phases: the lit row first, which maps spatially onto the
// physical box, then the digit, which names the row unambiguously. Row 1 is the
// one case where a lit row and the digit 1 look alike, so showing both in turn
// removes the ambiguity without giving up the spatial cue.
const uint16_t MATRIX_RESULT_ROW_MS = 2000;
// The digit gets twice the row's time. It is the part you actually have to read
// and carry to the box, and two seconds was gone before you had looked up.
const uint16_t MATRIX_RESULT_DIGIT_MS = 4000;
const uint16_t MATRIX_RESULT_HOLD_MS = MATRIX_RESULT_ROW_MS + MATRIX_RESULT_DIGIT_MS;

// The faces and the alert band have no second phase and nothing to read, so
// they keep their own hold rather than inheriting the digit's.
const uint16_t MATRIX_NOTICE_HOLD_MS = 4000;
const uint16_t MATRIX_BLINK_CLOSED_MS = 130;

// Four phases: none, one, two, three dots. Slow enough to read as deliberate
// rather than flicker, fast enough that a lookup answered in 200ms still shows
// one frame of it instead of a blip.
const uint16_t MATRIX_THINK_STEP_MS = 280;
const uint8_t MATRIX_THINK_PHASES = 4;

uint32_t matrixThinkNextAt = 0;
uint8_t matrixThinkPhase = 0;

// The boot spinner turns a good deal faster than the thinking face blinks its
// dots: sixteen positions at the think cadence would take four and a half
// seconds a revolution, which reads as broken rather than busy. At 90ms a turn
// takes 1.44s, about what a browser spinner does.
const uint16_t MATRIX_SPIN_STEP_MS = 90;

// The wave steps faster than the spinner turns. It is standing in for sound,
// and sound moves.
const uint16_t MATRIX_WAVE_STEP_MS = 100;
const uint8_t MATRIX_SPIN_PHASES = 16;
uint32_t matrixSpinNextAt = 0;
uint8_t matrixSpinPhase = 0;

uint8_t matrixResultRow = 0;
uint8_t matrixResultColor = 0;
uint32_t matrixResultDigitAt = 0;
bool matrixResultDigitDrawn = true;

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

// Purple is deliberately not in the result palette (red / orange / green /
// white), so the idle face can never be mistaken for a lookup answer.
const uint8_t EYE_COLOR = purple;

// The face occupies y=2..6, leaving y=0..1 clear above it. Nothing depends on
// that, but it keeps the face off the top rows so it does not look cropped.
void drawFace(bool eyesClosed) {
  matrixClear();

  // Two 2x2 eyes; a blink collapses each to its lower row so it reads as a lid
  // coming down rather than the display simply switching off.
  const uint8_t eyeColumns[] = {1, 5};
  for (uint8_t eye = 0; eye < 2; eye++) {
    const uint8_t x = eyeColumns[eye];
    if (!eyesClosed) {
      matrixSetPixel(x, 2, EYE_COLOR);
      matrixSetPixel(x + 1, 2, EYE_COLOR);
    }
    matrixSetPixel(x, 3, EYE_COLOR);
    matrixSetPixel(x + 1, 3, EYE_COLOR);
  }

  // Smile: the corners sit one row higher than the middle, which is what makes
  // it read as a smile rather than a straight line. The mouth stays put during
  // a blink - only the eyes move.
  matrixSetPixel(1, 5, EYE_COLOR);
  matrixSetPixel(6, 5, EYE_COLOR);
  for (uint8_t x = 2; x <= 5; x++) {
    matrixSetPixel(x, 6, EYE_COLOR);
  }
}

// Eyes open and still, with a mouth that fills in one dot at a time - the same
// "..." anything else shows while it waits. Purple like the idle face, and for
// the same reason: this is the box thinking, not an answer, and the result
// palette has to stay unambiguous.
void drawThinkingFace(uint8_t phase) {
  matrixClear();

  // Mismatched eyes: the left one is a row taller than the right. That
  // asymmetry is what makes the face read as quizzical rather than just awake -
  // the same trick Cozmo and Vector use. Both sit on the same baseline at y=3,
  // so the left eye reads as widening rather than the whole face sliding up.
  for (uint8_t y = 1; y <= 3; y++) {
    matrixSetPixel(1, y, EYE_COLOR);
    matrixSetPixel(2, y, EYE_COLOR);
  }
  for (uint8_t y = 2; y <= 3; y++) {
    matrixSetPixel(5, y, EYE_COLOR);
    matrixSetPixel(6, y, EYE_COLOR);
  }

  for (uint8_t dot = 0; dot < phase && dot < 3; dot++) {
    matrixSetPixel(2 + dot * 2, 6, EYE_COLOR);
  }
}

// A 16-cell octagon, clockwise from the top-left of the top edge - the roundest
// closed path an 8x8 panel has room for. Held as a table rather than computed,
// so the animation is an index step instead of trigonometry on a microcontroller.
const uint8_t SPINNER_RING[16][2] = {
  {2, 1}, {3, 1}, {4, 1}, {5, 1}, {6, 2}, {7, 3}, {7, 4}, {6, 5},
  {5, 6}, {4, 6}, {3, 6}, {2, 6}, {1, 5}, {0, 4}, {0, 3}, {1, 2},
};

const uint8_t SPINNER_LIT = 6;

// A spinner, not a face. The idle smiley means "I am fine" everywhere else in
// this sketch, and during boot the box is not fine yet - it is early. Six of the
// sixteen cells are lit, so the ten-cell gap is the part you actually read.
void drawSpinner(uint8_t phase) {
  matrixClear();

  for (uint8_t lit = 0; lit < SPINNER_LIT; lit++) {
    const uint8_t index = (uint8_t)((phase + MATRIX_SPIN_PHASES - lit) % MATRIX_SPIN_PHASES);
    // The leading cell is white and the tail purple: a uniform arc does not tell
    // you which way it is turning, and a spinner that might be going backwards
    // is worse than none.
    matrixSetPixel(SPINNER_RING[index][0], SPINNER_RING[index][1],
                   lit == 0 ? white : EYE_COLOR);
  }
}

// Filled, with the exclamation mark knocked out as unlit pixels rather than
// drawn. At 8x8 an outline triangle loses its shape and a drawn-on mark has
// nowhere to sit; matrixClear already blacks the frame, so the gaps are free.
//
// This replaces a solid red band, which was the loudest thing the panel can do
// and the least specific - it said "bad" and nothing else, and read more like a
// hardware fault than a message.
void drawAlertTriangle(uint8_t color) {
  matrixClear();

  matrixSetPixel(3, 0, color); matrixSetPixel(4, 0, color);
  matrixSetPixel(3, 1, color); matrixSetPixel(4, 1, color);

  // y=2..3: the sides only. The gap between them is the stem of the "!".
  for (uint8_t y = 2; y <= 3; y++) {
    matrixSetPixel(2, y, color);
    matrixSetPixel(5, y, color);
  }

  // y=4 is solid - the waist of the "!", between its stem and its dot.
  for (uint8_t x = 1; x <= 6; x++) {
    matrixSetPixel(x, 4, color);
  }

  // y=5 leaves x=3,4 dark: the dot.
  matrixSetPixel(1, 5, color); matrixSetPixel(2, 5, color);
  matrixSetPixel(5, 5, color); matrixSetPixel(6, 5, color);

  for (uint8_t x = 0; x < MATRIX_WIDTH; x++) {
    matrixSetPixel(x, 6, color);
  }
}

// Heights are deliberately irregular. A smooth repeating hump reads as a
// decoration rather than as sound; speech is uneven and the picture should be
// too. Thirty-two entries at 100ms a step means a cycle takes 3.2s, so a short
// recording never sees the pattern repeat.
const uint8_t WAVE_HEIGHTS[32] = {
  2, 5, 3, 8, 4, 6, 2, 7, 3, 5, 8, 2, 6, 4, 7, 3,
  5, 2, 8, 4, 3, 6, 2, 5, 7, 3, 4, 8, 2, 6, 3, 5,
};

// Colour by row rather than by column: pink at the centre line out to cyan at
// the edges, so a tall bar reaches colours a short one never shows and the
// palette itself reads as amplitude.
//
// This is the only picture the box draws in more than one colour, and that is
// the point - every other state is a single colour, so nothing else looks
// remotely like this. Listening is the one state where the box is taking input
// rather than giving output, and the person has to know the exact moment it
// starts.
const uint8_t WAVE_COLORS[8] = { cyan, blue, purple, pink, pink, purple, blue, cyan };

void drawSoundWave(uint8_t phase) {
  matrixClear();

  for (uint8_t x = 0; x < MATRIX_WIDTH; x++) {
    const uint8_t height = WAVE_HEIGHTS[(x + phase) % 32];
    // Centred, not grown from the bottom - a centred wave reads as a waveform,
    // a bottom-anchored one reads as a bar chart. Integer division puts odd
    // heights one row high of centre, which is part of what stops it looking
    // machined.
    const uint8_t top = (uint8_t)((MATRIX_HEIGHT - height) / 2);
    for (uint8_t y = top; y < top + height; y++) {
      matrixSetPixel(x, y, WAVE_COLORS[y]);
    }
  }
}

// The idle smile inverted: the middle of the mouth sits one row above its
// corners instead of below. Same face, so it reads as the box's own reaction
// rather than a new symbol to learn.
void drawSadFace(uint8_t color) {
  matrixClear();

  const uint8_t eyeColumns[] = {1, 5};
  for (uint8_t eye = 0; eye < 2; eye++) {
    const uint8_t x = eyeColumns[eye];
    matrixSetPixel(x, 2, color);
    matrixSetPixel(x + 1, 2, color);
    matrixSetPixel(x, 3, color);
    matrixSetPixel(x + 1, 3, color);
  }

  for (uint8_t x = 2; x <= 5; x++) {
    matrixSetPixel(x, 5, color);
  }
  matrixSetPixel(1, 6, color);
  matrixSetPixel(6, 6, color);
}

// Bigger than the 3x5 digits in both directions: a question mark needs five
// columns before it stops looking like a stray hook, and seven rows to fit the
// curve, the gap, and the dot that make it one. It is a symbol rather than a
// face on purpose - "I did not understand you" is a different statement from
// "I understood, and the answer is nothing", so it should not look like a mood.
const uint8_t QUESTION_HEIGHT = 7;
const uint8_t QUESTION_GLYPH[QUESTION_HEIGHT] = {
  0b01110,
  0b10001,
  0b00001,
  0b00010,
  0b00100,
  0b00000,
  0b00100,
};

const uint8_t QUESTION_ORIGIN_X = 2; // 5 wide in 8 columns.
const uint8_t QUESTION_ORIGIN_Y = 1; // 7 tall, leaving the top row clear.

void drawQuestionMark(uint8_t color) {
  matrixClear();

  for (uint8_t row = 0; row < QUESTION_HEIGHT; row++) {
    for (uint8_t column = 0; column < 5; column++) {
      if (QUESTION_GLYPH[row] & (1 << (4 - column))) {
        matrixSetPixel(QUESTION_ORIGIN_X + column, QUESTION_ORIGIN_Y + row, color);
      }
    }
  }
}

void scheduleNextBlink() {
  matrixNextBlinkAt = millis() + random(2000, 6000);
}

// 3x5 digits, one bit per pixel, most significant bit leftmost. Drawn into our
// own frame buffer rather than using the driver's displayNumber(): that renders
// on the device, where orientation is applied separately from user frames, so a
// built-in digit and the face would not agree on which way is up.
const uint8_t DIGIT_GLYPHS[10][5] = {
  {0b111, 0b101, 0b101, 0b101, 0b111}, // 0
  {0b010, 0b110, 0b010, 0b010, 0b111}, // 1
  {0b111, 0b001, 0b111, 0b100, 0b111}, // 2
  {0b111, 0b001, 0b111, 0b001, 0b111}, // 3
  {0b101, 0b101, 0b111, 0b001, 0b001}, // 4
  {0b111, 0b100, 0b111, 0b001, 0b111}, // 5
  {0b111, 0b100, 0b111, 0b101, 0b111}, // 6
  {0b111, 0b001, 0b001, 0b001, 0b001}, // 7
  {0b111, 0b101, 0b111, 0b101, 0b111}, // 8
  {0b111, 0b101, 0b111, 0b001, 0b111}, // 9
};

const uint8_t DIGIT_ORIGIN_X = 3; // 3 wide in 8 columns.
const uint8_t DIGIT_ORIGIN_Y = 2; // 5 tall in 8 rows.

void drawDigit(uint8_t digit, uint8_t color) {
  if (digit > 9) {
    return;
  }
  for (uint8_t row = 0; row < 5; row++) {
    const uint8_t bits = DIGIT_GLYPHS[digit][row];
    for (uint8_t column = 0; column < 3; column++) {
      if (bits & (0b100 >> column)) {
        matrixSetPixel(DIGIT_ORIGIN_X + column, DIGIT_ORIGIN_Y + row, color);
      }
    }
  }
}

// Certainty is null for any tool the camera has never seen, which is currently
// every tool in the box - so null gets its own colour rather than a fallback.
uint8_t certaintyColor(bool hasCertainty, int certainty) {
  if (!hasCertainty) {
    return white;
  }
  return certainty >= 75 ? green : orange;
}

// Shows the row as a digit rather than a lit row. On an 8x8 a digit is simply
// easier to read than counting rows, and it cannot be misread when the panel is
// mounted in an unexpected orientation. Rows outside 1-6 are not a valid
// toolbox row, so they fall through to the alert pattern instead of drawing a
// digit the box cannot mean.
void showMatrixRow(int rowNumber, bool hasCertainty, int certainty) {
  const uint8_t color = certaintyColor(hasCertainty, certainty);
  const bool validRow = rowNumber >= 1 && rowNumber <= 6;

  matrixClear();
  if (validRow) {
    matrixFillRow((uint8_t)rowNumber, color);
  } else {
    // Found, but in a drawer with no row assigned. There is no row to point at
    // and no digit to show, so light the whole indicator band instead.
    for (uint8_t y = MATRIX_FIRST_ROW_Y; y <= MATRIX_LAST_ROW_Y; y++) {
      matrixFillRow(y, color);
    }
  }

  matrixResultRow = validRow ? (uint8_t)rowNumber : 0;
  matrixResultColor = color;
  matrixResultDigitDrawn = !validRow; // Nothing to follow up with for an unknown row.
  matrixResultDigitAt = millis() + MATRIX_RESULT_ROW_MS;

  matrixMode = MATRIX_RESULT;
  matrixResultUntil = millis() + MATRIX_RESULT_HOLD_MS;
  matrixPush();
}

// Held until a response replaces it rather than for a fixed time: the box is
// thinking for exactly as long as it is waiting, and every exit from
// awaitingResponse - answer, rejection, or timeout - sets another mode.
void startMatrixThinking() {
  matrixMode = MATRIX_THINKING;
  matrixThinkPhase = 0;
  matrixThinkNextAt = millis() + MATRIX_THINK_STEP_MS;
  drawThinkingFace(matrixThinkPhase);
  matrixPush();
}

// Understood the word, found nothing.
void showMatrixSad(uint8_t color) {
  drawSadFace(color);
  matrixResultRow = 0;
  matrixResultDigitDrawn = true; // No row, so no digit follows.
  matrixMode = MATRIX_RESULT;
  matrixResultUntil = millis() + MATRIX_NOTICE_HOLD_MS;
  matrixPush();
}

// Did not understand the word at all.
void showMatrixUnknown(uint8_t color) {
  drawQuestionMark(color);
  matrixResultRow = 0;
  matrixResultDigitDrawn = true;
  matrixMode = MATRIX_RESULT;
  matrixResultUntil = millis() + MATRIX_NOTICE_HOLD_MS;
  matrixPush();
}

void showMatrixAlert(uint8_t color) {
  drawAlertTriangle(color);
  matrixResultRow = 0;
  matrixResultDigitDrawn = true; // An alert has no row, so no digit follows.
  matrixMode = MATRIX_RESULT;
  matrixResultUntil = millis() + MATRIX_NOTICE_HOLD_MS;
  matrixPush();
}

void updateMatrix() {
  if (!matrixReady) {
    return;
  }

  if (matrixMode == MATRIX_WAITING) {
    if (waitingLong) {
      return; // The face is drawn once by enterWaitingLong and then held.
    }

    if (millis() >= matrixSpinNextAt) {
      matrixSpinPhase = (uint8_t)((matrixSpinPhase + 1) % MATRIX_SPIN_PHASES);
      matrixSpinNextAt = millis() + MATRIX_SPIN_STEP_MS;
      drawSpinner(matrixSpinPhase);
      matrixPush();
    }
    return;
  }

  if (matrixMode == MATRIX_THINKING) {
    if (millis() >= matrixThinkNextAt) {
      matrixThinkPhase = (uint8_t)((matrixThinkPhase + 1) % MATRIX_THINK_PHASES);
      matrixThinkNextAt = millis() + MATRIX_THINK_STEP_MS;
      drawThinkingFace(matrixThinkPhase);
      matrixPush();
    }
    return;
  }

  if (matrixMode == MATRIX_RESULT) {
    if (!matrixResultDigitDrawn && millis() >= matrixResultDigitAt) {
      matrixClear();
      drawDigit(matrixResultRow, matrixResultColor);
      matrixResultDigitDrawn = true;
      matrixPush();
      return;
    }

    if (millis() >= matrixResultUntil) {
      matrixMode = MATRIX_EYES;
      matrixEyesClosed = false;
      drawFace(false);
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
      drawFace(false);
      scheduleNextBlink();
    }
  } else if (millis() >= matrixNextBlinkAt) {
    matrixEyesClosed = true;
    matrixEyesClosedUntil = millis() + MATRIX_BLINK_CLOSED_MS;
    drawFace(true);
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

void showWaitingStatus() {
  // The version stays on screen because this is exactly when someone wants to
  // know what is running, and the line it replaces ("Touch a pad") is an
  // instruction the box cannot honour yet.
  showStatus("SmartToolbox", waitingLong ? "No reply from Pi" : "Waiting for Pi",
             "v" FIRMWARE_VERSION);
}

// Past 90 seconds the spinner stops and the face drops. Purple, not the
// not-found red: a box still waiting on a server that has not finished booting
// has nothing to report as an error, and spending the alert here would leave
// nothing louder for a lookup that genuinely fails.
//
// Polled from loop() rather than from updateMatrix, where this began. That
// function returns early when no matrix is attached, which made the OLED line
// depend on a peripheral it has nothing to do with - and a box with no matrix
// is exactly the one that needs the screen to say something.
void pollWaitingLong() {
  if (deviceReady || waitingLong || millis() - waitingSince < WAITING_LONG_MS) {
    return;
  }
  waitingLong = true;

  showWaitingStatus();

  if (matrixReady) {
    drawSadFace(EYE_COLOR);
    matrixPush();
  }
}

// Entered before the OTA check rather than at the end of setup(). That check
// blocks for up to WIFI_CONNECT_TIMEOUT_MS when the radio cannot associate, so
// on the cold boot this exists for, setup() does not end until ~30s - by which
// point the Pi is nearly up and the waiting face would have six seconds to
// live. The face has to go up before anything that can block.
void startWaitingForPi() {
  deviceReady = false;
  waitingLong = false;
  waitingSince = millis();
  nextWaitingRetryAt = millis(); // Retry as soon as loop() runs.

  showWaitingStatus();

  matrixMode = MATRIX_WAITING;
  matrixSpinPhase = 0;
  matrixSpinNextAt = millis() + MATRIX_SPIN_STEP_MS;
  drawSpinner(matrixSpinPhase);
  matrixPush();
}

// Any reply at all promotes: success or error, the content is irrelevant. This
// is about proving the wire works end to end, not about the Pi liking the
// message.
void promoteToReady() {
  if (deviceReady) {
    return;
  }
  deviceReady = true;
  waitingLong = false;

  // This is the earliest moment a host is provably reading, which is exactly
  // what the OTA log needs - see reportLastOtaResult.
  reportLastOtaResult();

  showStatus("SmartToolbox", "Ready", MIC_BRINGUP ? "Hold D0 to record" : "Touch a pad");

  matrixMode = MATRIX_EYES;
  matrixEyesClosed = false;
  drawFace(false);
  // matrixNextBlinkAt was set back in setup() and is long past by now; without
  // this the face blinks the instant it settles, which reads as a glitch rather
  // than an arrival.
  scheduleNextBlink();
  matrixPush();
}

#if OTA_ENABLED
// Returns true only when an update was written and the device is about to
// reboot into it. Every failure path returns false and leaves the running
// firmware untouched: the ESP32 writes to the inactive OTA slot and only marks
// it bootable after Update.end() verifies the image, so a refused, corrupted,
// or interrupted download costs a boot delay, not the device.
bool checkForFirmwareUpdate() {
  if (strlen(SECRET_SSID) == 0) {
    lastOtaResult = "skipped - no Wi-Fi credentials";
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

    lastOtaResult = "no Wi-Fi - status " + String(WiFi.status()) + ", " + String(found) + " networks visible";
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
    lastOtaResult = "up to date at v" FIRMWARE_VERSION;
    showStatus("Up to date", "v" FIRMWARE_VERSION, "");
    http.end();
    WiFi.disconnect(true, true);
    WiFi.mode(WIFI_OFF);
    return false;
  }

  if (status != 200) {
    // 401 means the device key disagrees with the Pi; 503 means the Pi has no
    // key configured. Both are worth showing rather than silently skipping.
    lastOtaResult = "server said HTTP " + String(status);
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
    lastOtaResult = "cannot begin write, content-length " + String(contentLength);
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
    lastOtaResult = "write failed after " + String(written) + " of " + String(contentLength) + " bytes: " + String(Update.errorString());
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

bool beginMicrophone() {
  mic.setPinsPdmRx(MIC_CLOCK_PIN, MIC_DATA_PIN);

  // PDM_MONO is the only mode the S3 offers; see the constants above.
  if (!mic.begin(I2S_MODE_PDM_RX, MIC_SAMPLE_RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) {
    return false;
  }

  return true;
}

// that rises by an obvious multiple when spoken into is what proves the mic, and
// it is one number rather than 32,000.
//
// Reads in ~100ms chunks rather than one blocking call. Step 1 originally took
// the whole recording in a single readBytes, which was fine while the length was
// fixed and nothing had to happen during it. Hold-to-talk needs to notice the
// pad being released, and the wave needs to animate; neither is possible inside
// a call that does not return for two seconds.
//
// Returns bytes captured, or 0 if the hold was too short to be a word.
size_t recordWhileHeld(int16_t* samples, size_t pinIndex) {
  size_t bytesRead = 0;
  const uint32_t startedAt = millis();
  uint8_t wavePhase = 0;
  uint32_t nextWaveAt = millis();
  uint8_t releasedReads = 0;

  showStatus("Listening", "Speak now", "");

  while (bytesRead + MIC_CHUNK_BYTES <= MIC_MAX_BYTES) {
    if (matrixReady && millis() >= nextWaveAt) {
      nextWaveAt = millis() + MATRIX_WAVE_STEP_MS;
      drawSoundWave(wavePhase);
      wavePhase = (uint8_t)((wavePhase + 1) % 32);
      matrixPush();
    }

    bytesRead += mic.readBytes((char*)samples + bytesRead, MIC_CHUNK_BYTES);

    // Read the pad directly rather than calling pollTouch. That function owns
    // the press/release debounce and was the thing that dispatched us;
    // re-entering it from inside its own handler would leave that state
    // describing a moment that has already passed. One read per ~100ms chunk is
    // also far enough apart to keep the S3's touch peripheral happy - reading it
    // back to back is what makes it return a frozen value.
    const uint32_t touchValue = touchRead(TOUCH_PINS[pinIndex]);
    if (touchValue > touchBaseline[pinIndex] * TOUCH_TRIGGER_RATIO) {
      releasedReads = 0;
    } else {
      releasedReads++;
    }

    // Two consecutive below-threshold reads, the same rule pollTouch debounces
    // with: one noisy sample must not end a word mid-syllable. Checked after the
    // read, so the chunk a release lands in is still kept - it holds the end of
    // what was said.
    if (releasedReads >= 2 && millis() - startedAt >= MIC_MIN_HOLD_MS) {
      break;
    }

    if (millis() - startedAt >= MIC_MAX_HOLD_MS) {
      break; // The cap is what bounds the buffer; reaching it is not an error.
    }
  }

  if (millis() - startedAt < MIC_MIN_HOLD_MS) {
    return 0;
  }

  return bytesRead;
}

// Sends the recording as one line of base64 raw PCM on voice/audio, streamed
// straight out of PSRAM rather than built into a String first. Ten seconds is
// 320 KB of samples and ~427 KB of base64, which will not fit in the 320 KB of
// SRAM this chip has - so the JSON is written by hand in pieces and the base64
// is encoded three input bytes at a time on its way to the wire.
const char BASE64_ALPHABET[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

void sendVoiceAudio(const int16_t* samples, size_t byteCount) {
  requestCounter++;
  char idBuffer[16];
  snprintf(idBuffer, sizeof(idBuffer), "req-%lu", (unsigned long)requestCounter);

  Serial.print("{\"id\":\"");
  Serial.print(idBuffer);
  Serial.print("\",\"type\":\"request\",\"endpoint\":\"voice/audio\",\"body\":{");
  Serial.print("\"format\":\"pcm_s16le\",\"sampleRate\":");
  Serial.print(MIC_SAMPLE_RATE);
  Serial.print(",\"channels\":1,\"data\":\"");

  // Encoded into a staging buffer and flushed 240 bytes at a time, rather than
  // four bytes per Serial.write. A ten-second clip is ~107,000 quads, and one
  // USB CDC write per quad turns a transfer into a stall.
  const uint8_t* raw = (const uint8_t*)samples;
  char out[240];
  size_t outUsed = 0;

  for (size_t index = 0; index < byteCount; index += 3) {
    const size_t remaining = byteCount - index;
    const uint32_t chunk = ((uint32_t)raw[index] << 16) |
                           (remaining > 1 ? (uint32_t)raw[index + 1] << 8 : 0) |
                           (remaining > 2 ? (uint32_t)raw[index + 2] : 0);

    out[outUsed++] = BASE64_ALPHABET[(chunk >> 18) & 0x3F];
    out[outUsed++] = BASE64_ALPHABET[(chunk >> 12) & 0x3F];
    out[outUsed++] = remaining > 1 ? BASE64_ALPHABET[(chunk >> 6) & 0x3F] : '=';
    out[outUsed++] = remaining > 2 ? BASE64_ALPHABET[chunk & 0x3F] : '=';

    if (outUsed == sizeof(out)) {
      Serial.write((const uint8_t*)out, outUsed);
      outUsed = 0;
    }
  }

  if (outUsed > 0) {
    Serial.write((const uint8_t*)out, outUsed);
  }

  // println, so the terminating newline is the one the Pi splits lines on.
  Serial.println("\"}}");

  pendingRequestId = idBuffer;
  pendingToolName = "";
  pendingSince = millis();
  awaitingResponse = true;
  pendingIsVoice = true; // Transcription takes ~10s; the lookup timeout would fire long before.
}

void recordAndReportMic(size_t pinIndex) {
  if (!micReady) {
    Serial.println("MIC error=not-initialised");
    showStatus("Microphone", "Not initialised", "");
    return;
  }

  // PSRAM, not the heap: the cap is 320 KB, which is the whole of this chip's
  // SRAM and then some. Checked because a failed allocation and a dead
  // microphone produce exactly the same silence otherwise.
  int16_t* samples = (int16_t*)ps_malloc(MIC_MAX_BYTES);
  if (samples == nullptr) {
    // Almost always the build rather than the board: the XIAO has 8 MB of PSRAM,
    // but the Arduino default for this fqbn is PSRAM disabled, and ps_malloc
    // then returns null on every call. Compile with PSRAM=opi.
    Serial.println("MIC error=psram-alloc-failed");
    showStatus("Microphone", "No PSRAM", "Build PSRAM=opi");
    return;
  }

  const size_t bytesRead = recordWhileHeld(samples, pinIndex);
  const size_t sampleCount = bytesRead / MIC_BYTES_PER_SAMPLE;

  if (bytesRead == 0) {
    free(samples);
    Serial.println("MIC too-short");
    showStatus("Listening", "Too short", "Hold and speak");
    if (matrixReady) {
      drawFace(false);
      scheduleNextBlink();
      matrixPush();
    }
    return;
  }

  int16_t minSample = 0;
  int16_t maxSample = 0;
  int32_t mean = 0;
  uint32_t rms = 0;

  if (sampleCount > 0) {
    minSample = samples[0];
    maxSample = samples[0];

    // The PDM mic rides on a large positive DC bias, so the samples never cross
    // zero: the first real readings ran from +981 to +2568, centred near +1745.
    // RMS of the raw samples measures that bias rather than the sound, and read
    // 1745 then 1751 on two separate recordings - a number that barely moves is
    // the offset, not the room. Centre on the mean before squaring so the result
    // is how far the signal actually swings.
    int64_t sum = 0;
    for (size_t index = 0; index < sampleCount; index++) {
      const int16_t sample = samples[index];
      if (sample < minSample) {
        minSample = sample;
      }
      if (sample > maxSample) {
        maxSample = sample;
      }
      sum += sample;
    }
    mean = (int32_t)(sum / (int64_t)sampleCount);

    // Sum of squares of 32,000 samples overflows 32 bits, so accumulate in 64.
    uint64_t sumOfSquares = 0;
    for (size_t index = 0; index < sampleCount; index++) {
      const int32_t centred = (int32_t)samples[index] - mean;
      sumOfSquares += (uint64_t)((int64_t)centred * centred);
    }

    rms = (uint32_t)sqrt((double)(sumOfSquares / sampleCount));
  }

  // Plain text, not JSON: the Pi echoes unrecognised lines to its journal via
  // [serial-debug], which is exactly where these want to land during bring-up.
  // Kept alongside the transcript because it is the one number that says whether
  // an empty transcript means silence or a broken microphone.
  Serial.print("MIC samples=");
  Serial.print(sampleCount);
  Serial.print(" min=");
  Serial.print(minSample);
  Serial.print(" max=");
  Serial.print(maxSample);
  Serial.print(" mean=");
  Serial.print(mean);
  Serial.print(" rms=");
  Serial.println(rms);

  showStatus("Transcribing", String(sampleCount / (MIC_SAMPLE_RATE / 1000)) + "ms audio", "");
  startMatrixThinking();
  sendVoiceAudio(samples, bytesRead);

  free(samples);
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
  showStatus("SmartToolbox", "Starting up", "v" FIRMWARE_VERSION);

  // Presence check before the OTA block, so the face is up during the update
  // check rather than leaving the panel undefined for the Wi-Fi timeout.
  matrix.scanGroveTwoRGBLedMatrixI2CAddress();
  matrixReady = matrix.getDeviceVID() == GROVE_TWO_RGB_LED_MATRIX_VID;
  Serial.print("Matrix ready=");
  Serial.println(matrixReady ? 1 : 0);

  if (matrixReady) {
    matrix.stopDisplay();
    matrix.setDisplayOrientation(MATRIX_ORIENTATION);
    randomSeed(esp_random()); // Blink intervals are randomised; without this every boot blinks identically.
    scheduleNextBlink();
  }

  // Before the OTA check, not after it. That check blocks for up to
  // WIFI_CONNECT_TIMEOUT_MS when the radio cannot associate, so on a cold
  // whole-box start setup() does not finish until ~30s - and the Pi answers at
  // ~36.6s. Entering WAITING at the end of setup() would give the spinner six
  // seconds to live in the one case it exists for.
  startWaitingForPi();

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

  // The boot check has already run by here, and on a cold whole-box start it
  // will have failed for the reason given at FIRMWARE_FIRST_CHECK_MS. Re-check
  // shortly rather than after a full interval.
  nextFirmwareCheckAt = millis() + FIRMWARE_FIRST_CHECK_MS;

  micReady = beginMicrophone();
  Serial.print("Mic ready=");
  Serial.println(micReady ? 1 : 0);

  // The first of the waiting retries. Everything above has overwritten the OLED
  // - the update check and the calibration line both - so the waiting screen
  // goes back up here. "Ready" is no longer said at the end of setup(): it is
  // said by promoteToReady, when the Pi has actually answered.
  sendDeviceStatus();
  nextWaitingRetryAt = millis() + WAITING_RETRY_MS; // That send was the first retry.
  showWaitingStatus();
}

void loop() {
  pollTouch();
  pollSerialResponses();
  pollResponseTimeout();
  pollWaitingRetry();
  pollWaitingLong();
  pollDeviceStatus();
#if OTA_ENABLED
  pollFirmwareUpdate();
#endif
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

#if MIC_BRINGUP
  // Bring-up takes the pad over entirely. The lookup path is proven and is not
  // being changed here - it comes back by setting MIC_BRINGUP to 0.
  recordAndReportMic((size_t)pinIndex);
  return;
#else
  const char* toolName = TOUCH_TOOL_NAMES[pinIndex];
  if (toolName == nullptr) {
    return;
  }

  // Inside the lookup path deliberately, not at the top of this function: with
  // MIC_BRINGUP set the pad records instead, and recording never involves the
  // Pi, so a blanket guard would make mic bring-up untestable on any bench
  // where nothing answers.
  //
  // A touch here is someone asking "is it on?", and the honest answer is
  // already on the screen. Sending the lookup anyway would come back "No
  // response - Is the Pi service up?", blaming a Pi that is merely booting.
  if (!deviceReady) {
    showWaitingStatus();
    return;
  }

  sendToolLookupRequest(toolName);
#endif
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
  pendingIsVoice = false;

  showStatus("Looking up", pendingToolName, "");
  startMatrixThinking();
}

// The Pi only ever hears from this device when someone uses it, so without a
// heartbeat the dashboard cannot tell "idle" from "unplugged", and the firmware
// version it reports is whatever it last managed to announce. That announcement
// is unreliable by nature: it goes out while the USB serial port is still
// re-enumerating after a reset, so the Pi is frequently not listening yet.
// Repeating it fixes both - a lost boot message costs one interval, not a
// version.
void sendDeviceStatus() {
  statusCounter++;
  char idBuffer[24];
  snprintf(idBuffer, sizeof(idBuffer), "status-%lu", (unsigned long)statusCounter);

  JsonDocument doc;
  doc["id"] = idBuffer;
  doc["type"] = "request";
  doc["endpoint"] = "device/status";
  doc["body"]["firmwareVersion"] = FIRMWARE_VERSION;
  // The Pi spots a restart by watching this run backwards, which works even when
  // the message sent at boot never arrived.
  doc["body"]["uptimeMs"] = millis();

  serializeJson(doc, Serial);
  Serial.print('\n');

  nextDeviceStatusAt = millis() + DEVICE_STATUS_INTERVAL_MS;
}

// Deliberately does not set awaitingResponse or pendingRequestId. This is fire
// and forget: the Pi's reply carries an id no one is waiting on, which
// handleLookupResponse already ignores, and claiming the pending slot would make
// a heartbeat cancel a lookup the user is waiting for.
void pollDeviceStatus() {
  if (!deviceReady || awaitingResponse || millis() < nextDeviceStatusAt) {
    return;
  }

  sendDeviceStatus();
}

// The boot handshake: keep asking every two seconds until something answers.
//
// Deliberately without the awaitingResponse guard that pollDeviceStatus uses.
// That guard is right for a heartbeat and fatal here - one unanswered request
// would wedge the device in WAITING forever, which is precisely the failure
// this whole path exists to remove. Nothing sets awaitingResponse during
// WAITING anyway except the serial bench trigger, and this must survive that
// too.
void pollWaitingRetry() {
  if (deviceReady || millis() < nextWaitingRetryAt) {
    return;
  }

  nextWaitingRetryAt = millis() + WAITING_RETRY_MS;
  sendDeviceStatus();
}

// The boot-time OTA log never survives: the check runs before the Pi has the
// port open, and the S3's USB CDC discards writes with no host attached. So it
// is held and printed once the link is proven.
//
// Called from promoteToReady, which is that moment exactly - a reply has come
// back. It used to fire on the first heartbeat, which was an approximation of
// the same thing and is now wrong: the waiting retry sends its first status two
// seconds after boot, and printing there would put the log straight back into
// the void it was rescued from.
// Plain text, so it lands in the Pi's [serial-debug] with no API change.
void reportLastOtaResult() {
  if (lastOtaResultReported) {
    return;
  }
  lastOtaResultReported = true;

  Serial.print("OTA last result: ");
  Serial.println(lastOtaResult);
}

#if OTA_ENABLED
// Idle-only, for the reason given at FIRMWARE_CHECK_INTERVAL_MS: a failed
// association blocks the loop for the whole Wi-Fi timeout, and doing that
// underneath a lookup would read as the device freezing.
void pollFirmwareUpdate() {
  if (awaitingResponse || blinkRemaining > 0 || millis() < nextFirmwareCheckAt) {
    return;
  }

  nextFirmwareCheckAt = millis() + FIRMWARE_CHECK_INTERVAL_MS;
  checkForFirmwareUpdate(); // Reboots into the new image if one was written.

  // Only reached when no update was taken. The check leaves its own outcome on
  // the OLED, which is the wrong screen for a box that is still waiting.
  if (!deviceReady) {
    showWaitingStatus();
  }
}
#endif

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

  JsonDocument doc;
  if (deserializeJson(doc, line) != DeserializationError::Ok) {
    return;
  }

  // Parsed before the awaitingResponse check below, and this ordering is the
  // whole boot handshake. sendDeviceStatus never claims the pending slot - by
  // design, so a heartbeat cannot cancel a lookup someone is waiting on - so
  // with the guard first, the Pi's reply to it was dropped before anything
  // looked at the line, and the device could never learn the Pi was up.
  //
  // Any parsed reply promotes, whatever it says. This is about proving the wire
  // works end to end, not about the Pi liking the message.
  promoteToReady();

  // The Pi cannot start a conversation - there is no Pi-initiated message type
  // and the transport only ever writes responses - so anything it wants this
  // device to do rides back on a reply the device asked for. The heartbeat is
  // the vehicle: every 30s when running, every 2s while still waiting at boot.
  handleDeviceCommand(doc);

  if (!awaitingResponse) {
    return;
  }

  const char* responseId = doc["id"] | "";
  if (pendingRequestId != responseId) {
    return; // Not the response we're waiting on - ignore.
  }

  awaitingResponse = false;

  // Voice answers before the lookup branches, because its body is a transcript
  // rather than a drawer and none of what follows applies to it. This is
  // docs/PLAN-mic-bringup.md's whole scope: say a word, see the word. Turning
  // the word into a drawer is PLAN-voice-lookup.md and is deliberately not here.
  if (pendingIsVoice) {
    pendingIsVoice = false;
    handleVoiceResponse(doc);
    return;
  }

  const bool success = doc["success"] | false;
  if (!success) {
    showStatus("Didn't catch that", pendingToolName, doc["error"]["code"] | "lookup failed");
    startBlinkPlan(1, 1000, 1000); // Long blink: error.
    showMatrixUnknown(orange);
    return;
  }

  const bool found = doc["body"]["found"] | false;
  if (!found) {
    showStatus("Not found", pendingToolName, "");
    startBlinkPlan(3, 150, 150); // Fast blinks: not found.
    showMatrixSad(red);
    return;
  }

  // Every field below comes from primaryLocation, deliberately. Reading the row
  // from rows[0] and the label from drawers[0] mixed two different drawers: the
  // arrays are ordered independently, and SQLite sorts NULL row numbers first,
  // so a tool in an unnumbered drawer and a numbered one displayed the second
  // drawer's row beside the first drawer's label. The Pi now picks one location
  // and this reads only that.
  JsonObject primary = doc["body"]["primaryLocation"];
  const int rowNumber = primary["rowNumber"] | 0;

  // The row number is all the LED and the 8x8 matrix can convey. The drawer
  // label is the half only the OLED can show - see Physical Layout in the spec,
  // where row 1 spans drawers 1A/1B/1C.
  const char* drawerLabel = primary["label"] | "";
  const bool ambiguous = doc["body"]["hasMultipleLocations"] | false;

  // Say so when the tool is on record in more than one drawer, rather than
  // showing one of them as though it were the answer.
  showStatus("Found", pendingToolName,
             "Row " + String(rowNumber) + "  Drawer " + drawerLabel + (ambiguous ? " +" : ""));

  // certainty is null for a tool the camera has never observed - distinguish
  // "no reading" from a low reading rather than collapsing both to a number.
  JsonVariant certainty = primary["confidence"];
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

// Acts on a command the Pi left waiting. The Pi delivers each one exactly once,
// so there is nothing to acknowledge and nothing to clear - collecting it is the
// acknowledgement.
void handleDeviceCommand(JsonDocument& doc) {
  const char* command = doc["body"]["command"] | "";
  if (strlen(command) == 0) {
    return;
  }

  Serial.print("CMD ");
  Serial.println(command);

  if (strcmp(command, "check-firmware") == 0) {
#if OTA_ENABLED
    // Due now. pollFirmwareUpdate still refuses to run mid-lookup, so this asks
    // for the check at the next idle moment rather than forcing one here - the
    // check can block for the whole Wi-Fi timeout and doing that underneath a
    // lookup would read as the device freezing.
    nextFirmwareCheckAt = millis();
    showStatus("Update check", "Requested", "v" FIRMWARE_VERSION);
#else
    Serial.println("CMD check-firmware ignored: OTA_ENABLED=0");
#endif
    return;
  }

  if (strcmp(command, "reboot") == 0) {
    showStatus("Rebooting", "Asked by the Pi", "v" FIRMWARE_VERSION);
    Serial.flush(); // The restart is immediate; without this the line above is lost.
    delay(100);
    ESP.restart();
  }
}

// The OLED is 128px wide in a 6px font, so 21 characters is the line. Whisper
// returns a whole sentence and the screen shows what fits - the transcript also
// goes out over serial in full, which is where a long one is actually readable.
const size_t OLED_LINE_CHARS = 21;

void handleVoiceResponse(JsonDocument& doc) {
  if (!(doc["success"] | false)) {
    const char* code = doc["error"]["code"] | "transcription failed";
    Serial.print("VOICE error=");
    Serial.println(code);
    showStatus("Didn't catch that", code, "");
    startBlinkPlan(1, 1000, 1000);
    showMatrixUnknown(orange);
    return;
  }

  const char* transcript = doc["body"]["transcript"] | "";
  Serial.print("VOICE transcript=");
  Serial.println(transcript);

  // Whisper returns an empty string for silence rather than an error, so this
  // is a real outcome and not a fault. The rms printed alongside the recording
  // is what separates "the room was quiet" from "the microphone is broken".
  if (strlen(transcript) == 0) {
    showStatus("Heard nothing", "Hold and speak", "");
    startBlinkPlan(3, 150, 150);
    showMatrixSad(red);
    return;
  }

  String heard(transcript);
  showStatus("Heard", heard.substring(0, OLED_LINE_CHARS),
             heard.length() > OLED_LINE_CHARS ? heard.substring(OLED_LINE_CHARS, OLED_LINE_CHARS * 2) : "");

  // No row to blink and no drawer to point at - this endpoint only reports what
  // was said. One short blink acknowledges it without borrowing a lookup's
  // vocabulary.
  startBlinkPlan(1, 200, 200);

  // Straight back to idle. The matrix cannot show words, and holding any picture
  // here would be inventing a meaning for one - the transcript is on the OLED,
  // which is the half that can actually carry it.
  if (matrixReady) {
    matrixMode = MATRIX_EYES;
    matrixEyesClosed = false;
    drawFace(false);
    scheduleNextBlink();
    matrixPush();
  }
}

void pollResponseTimeout() {
  const uint32_t limit = pendingIsVoice ? VOICE_TIMEOUT_MS : RESPONSE_TIMEOUT_MS;
  if (awaitingResponse && millis() - pendingSince > limit) {
    awaitingResponse = false;
    const bool wasVoice = pendingIsVoice;
    pendingIsVoice = false;
    showStatus("No response", wasVoice ? "Transcription" : pendingToolName, "Is the Pi service up?");
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

