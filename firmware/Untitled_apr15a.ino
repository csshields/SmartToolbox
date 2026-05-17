#include "arduino_secrets.h"
#include <eloquent_esp32cam.h>
#include <U8g2lib.h>
// #include <MUIU8g2.h>
#include <U8x8lib.h>


#include <Wire.h>
#include "Seeed_Arduino_SSCMA.h"
#include "grove_two_rgb_led_matrix.h"
#include "thingProperties.h"

#ifdef ARDUINO_SAMD_VARIANT_COMPLIANCE
#define SERIAL_PORT_MONITOR SerialUSB
#else
#define SERIAL_PORT_MONITOR Serial
#endif

GroveTwoRGBLedMatrixClass matrix;
SSCMA AI;

bool matrixReady = false;
bool visionReady = false;
bool personDetected = false;
int highestPersonScore = 0;
unsigned long lastVisionPollMs = 0;

const uint8_t PERSON_TARGET_ID = 0;
const uint8_t PERSON_SCORE_THRESHOLD = 60;
const unsigned long VISION_POLL_INTERVAL_MS = 500;

U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, /* reset= */ U8X8_PIN_NONE);
bool oledReady = false;

enum DisplayType { DISP_OFF, DISP_COLOR, DISP_EMOJI, DISP_NUMBER };
DisplayType displayType = DISP_OFF;
uint32_t displayColorRgb = 0;
uint8_t displayEmojiIndex = 0;
int16_t displayNumber = 0;

// Last-sent state — only update matrix when something changes
DisplayType lastSentType = DISP_OFF;
uint32_t lastSentColorRgb = 0;
uint8_t lastSentEmojiIndex = 0xFF;
int16_t lastSentNumber = 0;
bool lastSentPersonDetected = false;

void parseMatrixDisplay(const String& val) {
  String v = val;
  v.trim();
  v.toLowerCase();

  // Colors
  if (v == "" || v == "off")  { displayType = DISP_OFF;   return; }
  if (v == "red")    { displayType = DISP_COLOR; displayColorRgb = 0xFF0000; return; }
  if (v == "orange") { displayType = DISP_COLOR; displayColorRgb = 0xFF8000; return; }
  if (v == "yellow") { displayType = DISP_COLOR; displayColorRgb = 0xFFFF00; return; }
  if (v == "green")  { displayType = DISP_COLOR; displayColorRgb = 0x00FF00; return; }
  if (v == "cyan")   { displayType = DISP_COLOR; displayColorRgb = 0x00FFFF; return; }
  if (v == "blue")   { displayType = DISP_COLOR; displayColorRgb = 0x0000FF; return; }
  if (v == "purple") { displayType = DISP_COLOR; displayColorRgb = 0xFF00FF; return; }
  if (v == "white")  { displayType = DISP_COLOR; displayColorRgb = 0xFFFFFF; return; }

  // Emojis
  if (v == "smile")  { displayType = DISP_EMOJI; displayEmojiIndex = 0;  return; }
  if (v == "laugh")  { displayType = DISP_EMOJI; displayEmojiIndex = 1;  return; }
  if (v == "sad")    { displayType = DISP_EMOJI; displayEmojiIndex = 2;  return; }
  if (v == "mad")    { displayType = DISP_EMOJI; displayEmojiIndex = 3;  return; }
  if (v == "angry")  { displayType = DISP_EMOJI; displayEmojiIndex = 4;  return; }
  if (v == "cry")    { displayType = DISP_EMOJI; displayEmojiIndex = 5;  return; }
  if (v == "cool")   { displayType = DISP_EMOJI; displayEmojiIndex = 7;  return; }
  if (v == "heart")  { displayType = DISP_EMOJI; displayEmojiIndex = 10; return; }
  if (v == "flame")  { displayType = DISP_EMOJI; displayEmojiIndex = 14; return; }
  if (v == "duck")   { displayType = DISP_EMOJI; displayEmojiIndex = 27; return; }
  if (v == "cat")    { displayType = DISP_EMOJI; displayEmojiIndex = 29; return; }
  if (v == "up")     { displayType = DISP_EMOJI; displayEmojiIndex = 30; return; }
  if (v == "down")   { displayType = DISP_EMOJI; displayEmojiIndex = 31; return; }
  if (v == "left")   { displayType = DISP_EMOJI; displayEmojiIndex = 32; return; }
  if (v == "right")  { displayType = DISP_EMOJI; displayEmojiIndex = 33; return; }

  // Number (e.g. "42", "-5")
  bool isNum = (v.length() > 0);
  uint8_t start = (v[0] == '-' || v[0] == '+') ? 1 : 0;
  if (v.length() <= start) isNum = false;
  for (uint8_t i = start; i < v.length() && isNum; i++) {
    if (!isDigit(v[i])) isNum = false;
  }
  if (isNum) {
    displayType = DISP_NUMBER;
    displayNumber = (int16_t)constrain(v.toInt(), -32767, 32767);
    return;
  }

  displayType = DISP_OFF;
}



bool visionSeesPerson() {
  if (!visionReady) return false;
  
  highestPersonScore = 0;
  
  for (size_t i = 0; i < AI.boxes().size(); i++) {
    if (AI.boxes()[i].target == PERSON_TARGET_ID) {
      if (AI.boxes()[i].score > highestPersonScore) {
        highestPersonScore = AI.boxes()[i].score;
      }
    }
  }
  
  for (size_t i = 0; i < AI.classes().size(); i++) {
    if (AI.classes()[i].target == PERSON_TARGET_ID) {
      if (AI.classes()[i].score > highestPersonScore) {
        highestPersonScore = AI.classes()[i].score;
      }
    }
  }
  
  return highestPersonScore >= PERSON_SCORE_THRESHOLD;
}

void updateVisionDetection() {


  if (!visionReady) return;
  if (millis() - lastVisionPollMs < VISION_POLL_INTERVAL_MS) return;

  int invokeResult = AI.invoke(1, false, false);
  if (invokeResult != 0) {
    SERIAL_PORT_MONITOR.print("Invoke failed: ");
    SERIAL_PORT_MONITOR.println(invokeResult);
    delay(200); // brief back-off before next attempt
    return;
  }

  lastVisionPollMs = millis();

  if (invokeResult != 0) {
    SERIAL_PORT_MONITOR.print("Invoke failed: ");
    SERIAL_PORT_MONITOR.println(invokeResult);
    return;
  }

  SERIAL_PORT_MONITOR.print("boxes: ");
  SERIAL_PORT_MONITOR.print(AI.boxes().size());
  SERIAL_PORT_MONITOR.print("  classes: ");
  SERIAL_PORT_MONITOR.println(AI.classes().size());

  bool detectedNow = visionSeesPerson();
  SERIAL_PORT_MONITOR.print("Highest person score: ");
  SERIAL_PORT_MONITOR.println(highestPersonScore);

  if (detectedNow != personDetected) {
    personDetected = detectedNow;
    SERIAL_PORT_MONITOR.print("Vision person detected: ");
    SERIAL_PORT_MONITOR.println(personDetected ? "YES" : "NO");
  }

  if (personConfidence != highestPersonScore) {
    personConfidence = highestPersonScore;
  }
}

void updateMatrixOutput() {
  if (!matrixReady) {
    return;
  }

  if (personDetected) {
    if (!lastSentPersonDetected) {
      matrix.displayColorBlock(0x00FF00, 0, true);
      lastSentPersonDetected = true;
    }
    return;
  }
  lastSentPersonDetected = false;

  if (displayType == lastSentType
      && (displayType != DISP_COLOR  || displayColorRgb  == lastSentColorRgb)
      && (displayType != DISP_EMOJI  || displayEmojiIndex == lastSentEmojiIndex)
      && (displayType != DISP_NUMBER || displayNumber     == lastSentNumber)) {
    return; // nothing changed
  }

  switch (displayType) {
    case DISP_COLOR:
      matrix.displayColorBlock(displayColorRgb, 0, true);
      lastSentColorRgb = displayColorRgb;
      break;
    case DISP_EMOJI:
      matrix.displayEmoji(displayEmojiIndex, 0, true);
      lastSentEmojiIndex = displayEmojiIndex;
      break;
    case DISP_NUMBER:
      matrix.displayNumber(displayNumber, 0, true, 0xfe);
      lastSentNumber = displayNumber;
      break;
    case DISP_OFF:
    default:
      matrix.stopDisplay();
      break;
  }
  lastSentType = displayType;
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);

  SERIAL_PORT_MONITOR.begin(9600);
  delay(1500);

  Wire.begin();
  delay(1000);

  // OLED first — simple device, gets I2C address claim early
  if (u8g2.begin()) {
    oledReady = true;
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_ncenB08_tr);
    u8g2.drawStr(0, 12, "XIAO Vision");
    u8g2.drawStr(0, 28, "Initializing...");
    u8g2.sendBuffer();
    SERIAL_PORT_MONITOR.println("OLED ready.");
  } else {
    SERIAL_PORT_MONITOR.println("OLED FAILED to init.");
  }

  // Vision AI second
  if (AI.begin(&Wire)) {
    visionReady = true;
    SERIAL_PORT_MONITOR.println("Vision AI ready.");
    // ... rest of your AI info prints
  } else {
    SERIAL_PORT_MONITOR.println("Vision AI FAILED.");
  }

  // Matrix third
  matrix.scanGroveTwoRGBLedMatrixI2CAddress();
  uint16_t vid = matrix.getDeviceVID();
  if (vid == GROVE_TWO_RGB_LED_MATRIX_VID) {
    matrixReady = true;
    matrix.stopDisplay();
    SERIAL_PORT_MONITOR.println("RGB LED matrix detected.");
  } else {
    SERIAL_PORT_MONITOR.println("RGB LED matrix not detected.");
  }

  // Cloud last
  initProperties();
  ArduinoCloud.begin(ArduinoIoTPreferredConnection);
  setDebugMessageLevel(2);
  ArduinoCloud.printDebugInfo();

  onLEDChange();
  onMatrixDisplayChange();
  updateMatrixOutput();
}

void loop() {
  ArduinoCloud.update();
  updateVisionDetection();
  updateMatrixOutput();
  updateOledDisplay();
}

void onTestChange() {
}

void onLEDChange() {
  digitalWrite(LED_BUILTIN, LED ? LOW : HIGH);
}

void updateOledDisplay() {
  if (!oledReady) return;

  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_ncenB08_tr);

  // Line 1: title
  u8g2.drawStr(0, 12, "Vision Monitor");

  // Line 2: person detection status
  if (personDetected) {
    u8g2.drawStr(0, 28, "Person: YES");
  } else {
    u8g2.drawStr(0, 28, "Person: NO");
  }

  // Line 3: confidence score
  char scoreBuf[24];
  snprintf(scoreBuf, sizeof(scoreBuf), "Confidence: %d%%", highestPersonScore);
  u8g2.drawStr(0, 44, scoreBuf);

  // Line 4: matrix display mode
  const char* modeStr = "Mode: off";
  if      (displayType == DISP_COLOR)  modeStr = "Mode: color";
  else if (displayType == DISP_EMOJI)  modeStr = "Mode: emoji";
  else if (displayType == DISP_NUMBER) modeStr = "Mode: number";
  u8g2.drawStr(0, 60, modeStr);

  u8g2.sendBuffer();
}

void onMatrixDisplayChange() {
  SERIAL_PORT_MONITOR.print("Matrix display: ");
  SERIAL_PORT_MONITOR.println(matrixDisplay);
  parseMatrixDisplay(matrixDisplay);
  updateMatrixOutput();
}
/*
  Since RedMatrix is READ_WRITE variable, onRedMatrixChange() is
  executed every time a new value is received from IoT Cloud.
*/
void onRedMatrixChange()  {
  // Add your code here to act upon RedMatrix change
}