#include <Wire.h>
#include "grove_two_rgb_led_matrix.h"
#include <U8g2lib.h>

#define PIR_PIN D0

GroveTwoRGBLedMatrixClass matrix;
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

bool matrixReady = false;
bool motionDetected = false;
bool lastMotionState = false;

void setup() {
  Serial.begin(9600);
  pinMode(PIR_PIN, INPUT);
  Wire.begin();
  delay(1000);

  // Init OLED
  if (u8g2.begin()) {
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_ncenB08_tr);
    u8g2.drawStr(0, 16, "PIR Test");
    u8g2.drawStr(0, 32, "Waiting...");
    u8g2.sendBuffer();
    Serial.println("OLED ready.");
  }

  // Init matrix
  matrix.scanGroveTwoRGBLedMatrixI2CAddress();
  if (matrix.getDeviceVID() == GROVE_TWO_RGB_LED_MATRIX_VID) {
    matrixReady = true;
    matrix.stopDisplay();
    Serial.println("Matrix ready.");
  }

  Serial.println("PIR ready. Waiting for motion...");
}

void loop() {
  motionDetected = digitalRead(PIR_PIN) == HIGH;

  if (motionDetected != lastMotionState) {
    lastMotionState = motionDetected;

    if (motionDetected) {
      Serial.println("Motion detected!");

      // Light matrix red
      if (matrixReady) matrix.displayColorBlock(0xFF0000, 0, true);

      // Update OLED
      u8g2.clearBuffer();
      u8g2.setFont(u8g2_font_ncenB08_tr);
      u8g2.drawStr(0, 16, "PIR Test");
      u8g2.drawStr(0, 32, "MOTION!");
      u8g2.drawStr(0, 48, "Detected :)");
      u8g2.sendBuffer();

    } else {
      Serial.println("Motion stopped.");

      // Turn matrix off
      if (matrixReady) matrix.stopDisplay();

      // Update OLED
      u8g2.clearBuffer();
      u8g2.setFont(u8g2_font_ncenB08_tr);
      u8g2.drawStr(0, 16, "PIR Test");
      u8g2.drawStr(0, 32, "No motion.");
      u8g2.sendBuffer();
    }
  }
}