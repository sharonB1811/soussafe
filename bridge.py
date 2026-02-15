# bridge.py
# Reads JSON events from Arduino over serial.
# - Sends alert-worthy events to /api/trigger
# - Sends cancel/dismiss events to /api/resolve (so site can close alert)
#
# ✅ Fixes included:
# - Auto-reconnect if the port resets/disconnects
# - Avoids “Resource busy” by refusing to run if another process holds the port
# - Dedupe events so you don’t spam Flask/SNS
# - Handles both /dev/cu.* and /dev/tty.* patterns (macOS)
# - Lets you override PORT/BAUD/FLASK_BASE/DEVICE_ID via env vars
#
# ✅ NEW:
# - Risk is computed from Arduino-emitted event + prox + distance_cm and sent as "risk"
#   so app.py uses Arduino-side risk (provided_risk) instead of compute_risk().

import json
import os
import time
import requests
import serial
from serial.serialutil import SerialException

# ---------------- Config ----------------
PORT = os.getenv("SOUSSAFE_PORT", "/dev/cu.usbmodemB081849824842")
BAUD = int(os.getenv("SOUSSAFE_BAUD", "9600"))

FLASK_BASE = os.getenv("SOUSSAFE_FLASK_BASE", "http://127.0.0.1:5050").rstrip("/")
TRIGGER_URL = f"{FLASK_BASE}/api/trigger"
RESOLVE_URL = f"{FLASK_BASE}/api/resolve"

DEVICE_ID = os.getenv("SOUSSAFE_DEVICE_ID", "K01")

# Arduino emits many events; only some should create an alert in the web app.
ALERT_EVENTS = {
    "emergency_timeout",
    "emergency_touch_3tap",
    "timer_done",
}

# Arduino emits this when the emergency is cancelled.
DISMISS_EVENTS = {
    "emergency_cancel",
}

# Optional debug/no-op events
DEBUG_EVENTS = {
    "emergency_start",
    "ok_hold_5s",
}

# Dedupe window (seconds)
DEDUPE_WINDOW_SEC = float(os.getenv("SOUSSAFE_DEDUPE_SEC", "1.5"))
_last_sent = {}  # key -> timestamp

# Requests timeout
HTTP_TIMEOUT = float(os.getenv("SOUSSAFE_HTTP_TIMEOUT", "3.0"))


# ---------------- Helpers ----------------
def map_event_to_trigger(evt: str) -> str:
    # These should be treated as manual/emergency-type triggers.
    if (evt or "").startswith("emergency"):
        return "manual"
    if evt == "timer_done":
        return "manual"
    return "automatic"


def event_to_risk(event: str, prox, distance_cm) -> int:
    """
    Compute risk ONLY from Arduino-emitted data:
      - event type
      - prox boolean
      - distance_cm

    Output: integer 0..10
    """
    e = (event or "").strip()

    # Base risk by event (tweak these if you want different behavior)
    if e == "emergency_timeout":
        r = 10
    elif e == "emergency_touch_3tap":
        r = 9
    elif e == "timer_done":
        r = 6
    else:
        r = 4  # fallback

    # Proximity bump
    if prox is True:
        r += 1

    # Close distance bump
    try:
        d = float(distance_cm) if distance_cm is not None else None
    except Exception:
        d = None
    if d is not None and d <= 10:
        r += 1

    return max(0, min(int(r), 10))


def dedupe(key: str) -> bool:
    now = time.time()
    last = _last_sent.get(key, 0.0)
    if (now - last) < DEDUPE_WINDOW_SEC:
        return True
    _last_sent[key] = now
    return False


def post_json(url: str, payload: dict, label: str):
    try:
        r = requests.post(url, json=payload, timeout=HTTP_TIMEOUT)
        print(f"{label} -> Flask:", r.status_code, r.text[:250])
    except Exception as e:
        print(f"{label} POST failed:", e)


def open_serial() -> serial.Serial:
    """
    Open serial port safely. On macOS, /dev/cu.* is typically what you want.
    If the device disappears/reappears, this may need reconnect.
    """
    ser = serial.Serial(PORT, BAUD, timeout=1)
    # Arduino resets on serial open; give it a moment
    time.sleep(2)
    # Clear any boot noise
    try:
        ser.reset_input_buffer()
    except Exception:
        pass
    print("Bridge connected:", PORT, f"(baud={BAUD})")
    return ser


def is_port_busy_exception(e: Exception) -> bool:
    s = str(e).lower()
    return "resource busy" in s or "errno 16" in s


# ---------------- Main ----------------
def main():
    ser = None
    backoff = 1.0

    while True:
        # (re)connect serial if needed
        if ser is None:
            try:
                ser = open_serial()
                backoff = 1.0
            except SerialException as e:
                if is_port_busy_exception(e):
                    print(
                        f"Serial port busy: {PORT}\n"
                        "Close Arduino Serial Monitor / any other script using the port.\n"
                        "Tip: lsof | grep usbmodem"
                    )
                    time.sleep(2.0)
                else:
                    print("Serial open failed, retrying:", e)
                    time.sleep(backoff)
                    backoff = min(backoff * 1.6, 10.0)
                continue

        try:
            raw = ser.readline()
            line = raw.decode("utf-8", errors="ignore").strip()
        except SerialException as e:
            print("Serial read failed, reconnecting:", e)
            try:
                ser.close()
            except Exception:
                pass
            ser = None
            time.sleep(1.5)
            continue

        if not line:
            continue

        # Arduino prints both text + JSON. Only JSON lines start with "{"
        if not line.startswith("{"):
            print("ARDUINO:", line)
            continue

        try:
            msg = json.loads(line)
        except Exception:
            print("Bad JSON:", line)
            continue

        event = (msg.get("event") or "").strip()
        distance_cm = msg.get("distance_cm", None)
        prox = msg.get("prox", None)

        # -------- dismiss events (CLEAR the active alert) --------
        if event in DISMISS_EVENTS:
            if dedupe(f"resolve:{event}"):
                print(f"DEDUPED resolve {event}")
                continue

            payload = {
                "device": DEVICE_ID,
                "event": event,
                "distance_cm": distance_cm,
                "prox": prox,
            }
            print("RESOLVE POST", payload)
            post_json(RESOLVE_URL, payload, "RESOLVE")
            continue

        # -------- debug/no-op events --------
        if (event in DEBUG_EVENTS) or event.startswith("ok_") or event == "":
            print(f"IGNORED debug event={event} distance_cm={distance_cm} prox={prox}")
            continue

        # -------- alert events --------
        if event not in ALERT_EVENTS:
            print(f"IGNORED event={event} distance_cm={distance_cm} prox={prox}")
            continue

        # Dedupe alerts by event + distance bucket
        dist_key = round(distance_cm, 1) if isinstance(distance_cm, (int, float)) else str(distance_cm)
        if dedupe(f"alert:{event}:{dist_key}"):
            print(f"DEDUPED alert {event} {distance_cm}")
            continue

        risk = event_to_risk(event, prox, distance_cm)

        payload = {
            "device": DEVICE_ID,
            "trigger": map_event_to_trigger(event),
            "risk": risk,  # ✅ Arduino-side risk truth
            "distance_cm": distance_cm,
            "audio": None,
            "temp": None,
            "humidity": None,
            "prox": prox,   # optional debug
            "event": event, # optional debug (app.py ignores safely)
        }

        print("ALERT POST", payload)
        post_json(TRIGGER_URL, payload, "ALERT")


if __name__ == "__main__":
    main()
