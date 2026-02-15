import json
import time
import requests
import serial

PORT = "/dev/tty.usbmodemXXXX"   # <-- CHANGE THIS
BAUD = 115200
URL = "http://127.0.0.1:5050/api/trigger"

def main():
    ser = serial.Serial(PORT, BAUD, timeout=1)
    print(f"Listening on {PORT} @ {BAUD}")
    print(f"Posting to {URL}")

    while True:
        line = ser.readline().decode("utf-8", errors="ignore").strip()
        if not line:
            continue

        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            print("Skipping non-JSON line:", line)
            continue

        try:
            resp = requests.post(URL, json=payload, timeout=3)
            print("POST", resp.status_code, resp.json())
        except Exception as e:
            print("POST failed:", e)

        time.sleep(0.1)

if __name__ == "__main__":
    main()
