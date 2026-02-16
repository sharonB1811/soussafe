HACKATHON 2026 - #1 Overall Winner Project:
SousSafe is a hardware-integrated safety monitoring web application that connects an Arduino device to a live Flask web server. The system detects emergency interactions through physical sensors, sends structured JSON events to a local Python bridge, and updates a web dashboard in real time. Alerts are stored in a SQLite database and optionally sent to trusted contacts using AWS SNS.

The system consists of four main parts. The Arduino sketch runs on the microcontroller and monitors hardware inputs such as the touch sensor, ultrasonic sensor, timer, buzzer, and LED indicators. When something important happens, like a triple tap emergency trigger, a timer completion, or an emergency cancellation, the Arduino prints a JSON message to the serial port. These messages look like {"event":"emergency_touch_3tap","distance_cm":8.3,"prox":true}.

The bridge.py script runs on your laptop and listens to the Arduino over the serial port. It parses the JSON lines, ignores debug text, and forwards meaningful events to the Flask backend using HTTP requests. Emergency-triggering events are sent to /api/trigger. Cancel events are sent to /api/resolve. If the touch sensor is held for five seconds, the Arduino sends an ok_hold_5s event, which the bridge forwards to /api/ok to send an “I’m OK” notification through SNS without creating an active alert. The bridge also includes event deduplication to prevent spamming the backend.

The Flask backend (app.py) acts as the central system controller. It receives events from the bridge, stores alerts in a SQLite database, computes or accepts risk values, and determines whether an alert is active. The backend exposes endpoints like /api/trigger to create alerts, /api/resolve to clear alerts, /api/context to report the current active alert state to the frontend, and /api/contact to manage up to three trusted contacts. If the alert risk is greater than or equal to the configured threshold, Flask sends a notification through AWS SNS.

The frontend consists of HTML templates and static/app.js. The browser polls /api/context every few seconds to stay synchronized with the backend. If an active alert exists and meets the risk threshold, the alert overlay automatically appears. When the alert is resolved either by clicking dismiss in the UI or by triggering emergency_cancel on the Arduino, the overlay disappears. The frontend never communicates directly with the Arduino. It only reflects the backend’s current state.

To run SousSafe locally, open two terminals. In Terminal 1, start the Flask backend with AWS SNS configured:

export SNS_TOPIC_ARN="arn:aws:sns:us-east-1:712192388720:SousSafeAlerts"
export AWS_REGION="us-east-1"
python app.py

In Terminal 2, start the serial bridge that connects to the Arduino:

python bridge.py

Make sure the Arduino is connected and the correct serial port is configured inside bridge.py or set via the SOUSSAFE_PORT environment variable. Once both scripts are running, open your browser to [http://127.0.0.1:5050](http://127.0.0.1:5050).

The full event flow is: Arduino detects an event and prints JSON → bridge.py reads it and sends it to Flask → Flask stores the alert and optionally sends SNS → the browser polls /api/context and updates the UI accordingly.

SousSafe demonstrates real-time hardware-to-web integration, state synchronization between backend and frontend, event-driven architecture, and cloud notification integration using AWS SNS.
