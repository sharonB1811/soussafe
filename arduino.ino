#include <SoftwareSerial.h>

SoftwareSerial s7s(7, 8);

#define ROT_SIG A0

#define START_BTN 6
#define STOPRESET_BTN 4

#define BUZZ_PIN 3

#define US_TRIG_PIN 10
#define US_ECHO_PIN 9
#define LED_PIN     12

#define TOUCH_PIN   2

const float PROX_CM = 50.0;
const unsigned long US_TIMEOUT_US = 30000;

const float PROX_HYST_CM = 3.0;
static float distSmoothCm = -1.0;
const float DIST_ALPHA = 0.25;

const unsigned long TOUCH_TAP_GAP_MS = 800;
const unsigned long TOUCH_HOLD_MS    = 5000;

const bool TOUCH_ACTIVE_LOW = false;

void emitEvent(const char* eventType, float distanceCm, bool prox) {
  Serial.print("{\"event\":\"");
  Serial.print(eventType);
  Serial.print("\",\"distance_cm\":");
  if (distanceCm < 0) Serial.print("null");
  else Serial.print(distanceCm, 1);
  Serial.print(",\"prox\":");
  Serial.print(prox ? "true" : "false");
  Serial.println("}");
}

void clearDisplay() { s7s.write(0x76); }

void setColon(bool on) {
  s7s.write(0x77);
  s7s.write(on ? 0b00010000 : 0b00000000);
}

void showMMSS(long totalSeconds) {
  if (totalSeconds < 0) totalSeconds = 0;
  int mm = totalSeconds / 60;
  int ss = totalSeconds % 60;

  char buf[5];
  snprintf(buf, sizeof(buf), "%02d%02d", mm, ss);

  clearDisplay();
  s7s.print(buf);
  setColon(true);
}

bool pressedEvent(int pin) {
  static bool lastStart = HIGH;
  static bool lastStop  = HIGH;

  bool now = digitalRead(pin);
  bool *lastPtr = (pin == START_BTN) ? &lastStart : &lastStop;

  bool pressed = (*lastPtr == HIGH && now == LOW);
  *lastPtr = now;

  if (pressed) delay(25);
  return pressed;
}

void beepDone() {
  for (int i = 0; i < 3; i++) {
    tone(BUZZ_PIN, 2000, 150);
    delay(250);
  }
}

static float smooth = 0;

int readKnobFiltered() {
  int raw = analogRead(ROT_SIG);
  smooth = smooth * 0.85 + raw * 0.15;
  return (int)(smooth + 0.5);
}

const int MIN_SEC  = 15;
const int MAX_SEC  = 30 * 60;
const int STEP_SEC = 30;

long knobToSeconds(int knobVal) {
  long seconds = map(knobVal, 0, 1023, MIN_SEC, MAX_SEC);
  seconds = (seconds / STEP_SEC) * STEP_SEC;
  if (seconds < MIN_SEC) seconds = MIN_SEC;
  if (seconds > MAX_SEC) seconds = MAX_SEC;
  return seconds;
}

enum RunState { IDLE, COUNTDOWN };
RunState runState = IDLE;

long setSeconds = 30 * 60;
long remainingSeconds = 30 * 60;
unsigned long endMs = 0;

const unsigned long DOUBLE_CLICK_MS = 350;
bool clickPending = false;
unsigned long firstClickMs = 0;

void doSingleClickStop() {
  if (runState == COUNTDOWN) {
    long rem = (long)((endMs - millis()) / 1000UL);
    if (rem < 0) rem = 0;
    remainingSeconds = rem;
    runState = IDLE;
    Serial.println("STOP (paused)");
    showMMSS(remainingSeconds);
  } else {
    Serial.println("STOP clicked (idle) - no action");
  }
}

void doDoubleClickReset() {
  remainingSeconds = setSeconds;
  runState = IDLE;
  Serial.println("RESET -> back to set time");
  showMMSS(remainingSeconds);
}

void handleStopResetButtonSingleDouble() {
  if (pressedEvent(STOPRESET_BTN)) {
    unsigned long now = millis();

    if (!clickPending) {
      clickPending = true;
      firstClickMs = now;
    } else {
      if (now - firstClickMs <= DOUBLE_CLICK_MS) {
        clickPending = false;
        doDoubleClickReset();
      } else {
        firstClickMs = now;
      }
    }
  }

  if (clickPending && (millis() - firstClickMs > DOUBLE_CLICK_MS)) {
    clickPending = false;
    doSingleClickStop();
  }
}

const unsigned long EMERGENCY_MS = 15UL * 1000UL;
bool emergencyActive = false;
unsigned long emergencyEndMs = 0;

const unsigned long TAP_WINDOW_MS = 600;
uint8_t startTapCount = 0;
unsigned long firstTapMs = 0;
unsigned long lastTapMs  = 0;

unsigned long comboLockoutUntilMs = 0;
const unsigned long COMBO_LOCKOUT_MS = 500;

void toggleEmergency(unsigned long now, bool prox) {
  clickPending = false;
  comboLockoutUntilMs = now + COMBO_LOCKOUT_MS;

  if (!emergencyActive) {
    emergencyActive = true;
    emergencyEndMs = now + EMERGENCY_MS;
    Serial.println("EMERGENCY timer started (15 sec)");
    emitEvent("emergency_start", distSmoothCm, prox);
  } else {
    emergencyActive = false;
    Serial.println("EMERGENCY timer cancelled");
    emitEvent("emergency_cancel", distSmoothCm, prox);
  }
}

void doStartAction() {
  if (runState == IDLE) {
    runState = COUNTDOWN;
    endMs = millis() + (unsigned long)remainingSeconds * 1000UL;
    Serial.println("START/resume countdown");
  } else {
    Serial.println("START pressed while running (ignored)");
  }
}

void handleStartSingleVsTriple(bool prox) {
  unsigned long now = millis();

  if (emergencyActive && (long)(now - emergencyEndMs) >= 0) {
    emergencyActive = false;
    Serial.println("EMERGENCY alert sent");
    comboLockoutUntilMs = now + COMBO_LOCKOUT_MS;
    emitEvent("emergency_timeout", distSmoothCm, prox);
  }

  if (now < comboLockoutUntilMs) {
    startTapCount = 0;
    return;
  }

  if (pressedEvent(START_BTN)) {
    if (startTapCount == 0) {
      startTapCount = 1;
      firstTapMs = now;
      lastTapMs  = now;
    } else {
      if (now - lastTapMs > TAP_WINDOW_MS) {
        startTapCount = 1;
        firstTapMs = now;
        lastTapMs  = now;
      } else {
        startTapCount++;
        lastTapMs = now;
      }
    }

    if (startTapCount >= 3) {
      startTapCount = 0;
      toggleEmergency(now, prox);
      return;
    }
  }

  if (startTapCount > 0) {
    if (now - firstTapMs > TAP_WINDOW_MS) {
      doStartAction();
      startTapCount = 0;
      delay(150);
    }
  }
}

float readDistanceCmRaw() {
  digitalWrite(US_TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(US_TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(US_TRIG_PIN, LOW);

  unsigned long duration = pulseIn(US_ECHO_PIN, HIGH, US_TIMEOUT_US);
  if (duration == 0) return -1.0;

  return (float)duration / 58.0f;
}

float readDistanceCmFiltered() {
  float d = readDistanceCmRaw();
  if (d < 0) return distSmoothCm;

  if (distSmoothCm < 0) distSmoothCm = d;
  else distSmoothCm = distSmoothCm * (1.0f - DIST_ALPHA) + d * DIST_ALPHA;

  return distSmoothCm;
}

bool updateProximityState() {
  static bool proxState = false;

  float d = readDistanceCmFiltered();
  if (d < 0) {
    proxState = false;
    return proxState;
  }

  if (!proxState) {
    if (d <= (PROX_CM - PROX_HYST_CM)) proxState = true;
  } else {
    if (d >= (PROX_CM + PROX_HYST_CM)) proxState = false;
  }

  return proxState;
}

bool touchIsActive() {
  int v = digitalRead(TOUCH_PIN);
  if (TOUCH_ACTIVE_LOW) return (v == LOW);
  return (v == HIGH);
}

bool touchPressedEvent() {
  static bool lastActive = false;

  bool nowActive = touchIsActive();
  bool pressed = (!lastActive && nowActive);
  lastActive = nowActive;

  if (pressed) delay(20);
  return pressed;
}

void handleProxTouchSignals(bool prox) {
  static uint8_t tapCount = 0;
  static unsigned long lastTapMs = 0;

  static bool holding = false;
  static unsigned long holdStartMs = 0;
  static bool holdFired = false;

  if (!prox) {
    tapCount = 0;
    holding = false;
    holdFired = false;
    return;
  }

  unsigned long now = millis();
  bool active = touchIsActive();

  if (active) {
    if (!holding) {
      holding = true;
      holdStartMs = now;
      holdFired = false;
    } else {
      if (!holdFired && (now - holdStartMs >= TOUCH_HOLD_MS)) {
        holdFired = true;
        Serial.println("OK MESSAGE (touch held 5s while in proximity)");
        emitEvent("ok_hold_5s", distSmoothCm, prox);
      }
    }
  } else {
    holding = false;
    holdFired = false;
  }

  if (touchPressedEvent()) {
    if (tapCount > 0 && (now - lastTapMs > TOUCH_TAP_GAP_MS)) {
      tapCount = 0;
    }

    tapCount++;
    lastTapMs = now;

    if (tapCount >= 3) {
      tapCount = 0;
      Serial.println("EMERGENCY SIGNAL (3 touch taps while in proximity)");
      emitEvent("emergency_touch_3tap", distSmoothCm, prox);
    }
  }

  if (tapCount > 0 && (now - lastTapMs > TOUCH_TAP_GAP_MS)) {
    tapCount = 0;
  }
}

void setup() {
  Serial.begin(9600);

  pinMode(START_BTN, INPUT_PULLUP);
  pinMode(STOPRESET_BTN, INPUT_PULLUP);
  pinMode(BUZZ_PIN, OUTPUT);

  pinMode(US_TRIG_PIN, OUTPUT);
  pinMode(US_ECHO_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);

  pinMode(TOUCH_PIN, INPUT);

  s7s.begin(9600);
  delay(200);

  smooth = analogRead(ROT_SIG);

  Serial.println("SousSafe Arduino ready.");
  Serial.println("JSON events will be printed for the bridge script.");
  showMMSS(remainingSeconds);
}

void loop() {
  bool prox = updateProximityState();
  digitalWrite(LED_PIN, prox ? HIGH : LOW);

  handleProxTouchSignals(prox);

  handleStopResetButtonSingleDouble();

  handleStartSingleVsTriple(prox);

  if (runState == IDLE) {
    int knobVal = readKnobFiltered();
    long newSet = knobToSeconds(knobVal);

    if (newSet != setSeconds) {
      setSeconds = newSet;
      remainingSeconds = setSeconds;
      showMMSS(remainingSeconds);
    }
  }

  if (runState == COUNTDOWN) {
    long remaining = (long)((endMs - millis()) / 1000UL);
    if (remaining < 0) remaining = 0;

    showMMSS(remaining);

    if (remaining == 0) {
      Serial.println("DONE");
      emitEvent("timer_done", distSmoothCm, prox);

      beepDone();
      runState = IDLE;
      remainingSeconds = setSeconds;
      showMMSS(remainingSeconds);
      delay(200);
    }
  }

  delay(30);
}
