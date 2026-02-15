import json, time
import requests
import serial

PORT = "/dev/cu.usbmodemB081849824842"
BAUD = 9600
FLASK_TRIGGER_URL = "http://127.0.0.1:5050/api/trigger"
DEVICE_ID = "K01"

def map_event_to_trigger(evt: str) -> str:
    # map Arduino events -> your app's trigger types
    if evt.startswith("emergency"):
        return "manual"          # will score higher in compute_risk
    if evt.startswith("ok_"):
        return "automatic"
    return "automatic"

def main():
    ser = serial.Serial(PORT, BAUD, timeout=1)
    time.sleep(2)  # let Arduino reset/settle on serial open
    print("Bridge connected:", PORT)

    while True:
        line = ser.readline().decode("utf-8", errors="ignore").strip()
        if not line:
            continue

        # Arduino prints some plain text lines too; only parse JSON
        if not line.startswith("{"):
            print("ARDUINO:", line)
            continue

        try:
            msg = json.loads(line)
        except Exception:
            print("Bad JSON:", line)
            continue

        event = msg.get("event", "unknown")
        distance_cm = msg.get("distance_cm", None)

        payload = {
            "device": DEVICE_ID,
            "trigger": map_event_to_trigger(event),
            "distance_cm": distance_cm,
            # optional placeholders if you want:
            "audio": None,
            "temp": None,
            "humidity": None,
        }

        print("POST", payload)
        try:
            r = requests.post(FLASK_TRIGGER_URL, json=payload, timeout=3)
            print("Flask:", r.status_code, r.text[:200])
        except Exception as e:
            print("POST failed:", e)

if __name__ == "__main__":
    main()
