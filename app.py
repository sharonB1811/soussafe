# app.py
from flask import Flask, render_template, request, redirect, url_for, jsonify
import sqlite3
import secrets
from datetime import datetime
import os
import json

import boto3
from botocore.exceptions import BotoCoreError, ClientError

app = Flask(__name__)
app.secret_key = "dev-secret-change-me"

DB = "soussafe.db"

# ---------------- AWS (SNS) ----------------
# Env vars:
#   export SNS_TOPIC_ARN="arn:aws:sns:us-east-1:123456789012:SousSafeAlerts"
#   export AWS_REGION="us-east-1"
#   export ALERT_THRESHOLD="6"
SNS_TOPIC_ARN = os.getenv("SNS_TOPIC_ARN", "PASTE_YOUR_TOPIC_ARN_HERE")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
ALERT_THRESHOLD = int(os.getenv("ALERT_THRESHOLD", "6"))

sns = boto3.client("sns", region_name=AWS_REGION)

MAX_CONTACTS = 3

# ---------------- Image helper ----------------
IMAGE_DIR = os.path.join(app.root_path, "static", "images")


def image_url(stem: str) -> str:
    """Return /static/images/<stem>.(jpg|jpeg|png|webp) based on what exists."""
    for ext in ("jpg", "jpeg", "png", "webp"):
        p = os.path.join(IMAGE_DIR, f"{stem}.{ext}")
        if os.path.exists(p):
            return f"/static/images/{stem}.{ext}"
    return f"/static/images/{stem}.jpg"


# ---------------- DB helpers ----------------
def db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """
    - alerts: sensor snapshots
    - contacts: up to MAX_CONTACTS trusted contacts
    """
    conn = db()
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT NOT NULL,
            risk INTEGER NOT NULL,
            trigger_type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            audio_level INTEGER,
            temp REAL,
            humidity REAL,
            distance_cm REAL,
            device_id TEXT NOT NULL
        )
    """)

    # lightweight migration
    try:
        cols = {r["name"] for r in cur.execute("PRAGMA table_info(alerts)").fetchall()}
        if "distance_cm" not in cols:
            cur.execute("ALTER TABLE alerts ADD COLUMN distance_cm REAL")
    except sqlite3.Error:
        pass

    cur.execute("""
        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            method TEXT NOT NULL,
            value TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)

    conn.commit()
    conn.close()


# ---------------- Contacts helpers ----------------
def list_contacts():
    conn = db()
    rows = conn.execute("""
        SELECT id, name, method, value, created_at
        FROM contacts
        ORDER BY id ASC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def count_contacts() -> int:
    conn = db()
    n = conn.execute("SELECT COUNT(*) AS c FROM contacts").fetchone()["c"]
    conn.close()
    return int(n)


def contact_exists(method: str, value: str) -> bool:
    conn = db()
    row = conn.execute(
        "SELECT 1 FROM contacts WHERE lower(method)=lower(?) AND lower(value)=lower(?) LIMIT 1",
        (method, value),
    ).fetchone()
    conn.close()
    return row is not None


def add_contact(name: str, method: str, value: str) -> int:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = db()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO contacts (name, method, value, created_at) VALUES (?, ?, ?, ?)",
        (name, method, value, now),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return int(new_id)


def get_contact_by_id(contact_id: int):
    conn = db()
    row = conn.execute(
        "SELECT id, name, method, value, created_at FROM contacts WHERE id = ?",
        (contact_id,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_contact(contact_id: int) -> bool:
    conn = db()
    cur = conn.cursor()
    cur.execute("DELETE FROM contacts WHERE id = ?", (contact_id,))
    conn.commit()
    deleted = cur.rowcount > 0
    conn.close()
    return deleted


# ---------------- SNS helpers ----------------
def sns_is_configured() -> bool:
    return bool(SNS_TOPIC_ARN) and SNS_TOPIC_ARN != "PASTE_YOUR_TOPIC_ARN_HERE"


def sns_subscribe_email(email: str) -> dict:
    """
    Subscribe email endpoint to SNS topic.
    SNS requires email confirmation in inbox.
    """
    if not sns_is_configured():
        return {"ok": False, "subscription_arn": None, "error": "SNS_TOPIC_ARN not set"}

    try:
        resp = sns.subscribe(
            TopicArn=SNS_TOPIC_ARN,
            Protocol="email",
            Endpoint=email,
            ReturnSubscriptionArn=True,
        )
        arn = resp.get("SubscriptionArn")  # often "PendingConfirmation"
        return {"ok": True, "subscription_arn": arn, "error": None}
    except (BotoCoreError, ClientError) as e:
        return {"ok": False, "subscription_arn": None, "error": str(e)}


def try_publish_sns(payload: dict) -> dict:
    if not sns_is_configured():
        return {"ok": False, "message_id": None, "error": "SNS_TOPIC_ARN not set"}

    try:
        resp = sns.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject=f"SousSafe alert • risk {payload.get('risk')}",
            Message=(
                "SousSafe alert\n"
                f"Time: {payload.get('created_at')}\n"
                f"Device: {payload.get('device_id')}\n"
                f"Trigger: {payload.get('trigger_type')}\n"
                f"Risk: {payload.get('risk')}\n"
                f"Audio: {payload.get('audio_level')}\n"
                f"Temp: {payload.get('temp')}\n"
                f"Humidity: {payload.get('humidity')}\n"
                f"Distance(cm): {payload.get('distance_cm')}\n"
                f"Token: {payload.get('token')}\n"
                f"Link: {payload.get('public_link')}\n"
            ),
        )
        return {"ok": True, "message_id": resp.get("MessageId"), "error": None}
    except (BotoCoreError, ClientError) as e:
        return {"ok": False, "message_id": None, "error": str(e)}


# ---------------- Public Recipe Data ----------------
RECIPES = {
    "garlicpasta": {
        "title": "Garlic Pasta 🍝",
        "tag": "quick stove",
        "thumb": image_url("garlicpasta"),
        "meta": "15 min • 7 steps",
        "steps": ["Boil water", "Salt water", "Add pasta", "Stir", "Drain", "Add garlic + oil", "Serve"],
    },
    "stirfry": {
        "title": "Quick Stir Fry 🥦",
        "tag": "quick stove veg",
        "thumb": image_url("stirfry"),
        "meta": "20 min • 6 steps",
        "steps": ["Chop veggies", "Heat pan", "Add oil", "Stir fry", "Add sauce", "Serve"],
    },
    "eggfriedrice": {
        "title": "Egg Fried Rice 🍳",
        "tag": "quick stove",
        "thumb": image_url("eggfriedrice"),
        "meta": "15 min • 6 steps",
        "steps": ["Cook eggs", "Add rice", "Add veggies", "Add soy sauce", "Stir", "Serve"],
    },
    "lentilsoup": {
        "title": "Lentil Soup 🥣",
        "tag": "stove veg",
        "thumb": image_url("lentilsoup"),
        "meta": "35 min • 6 steps",
        "steps": ["Sauté aromatics", "Add lentils", "Add broth", "Simmer", "Season", "Serve"],
    },
    "cozysoup": {
        "title": "Cozy Soup 🍲",
        "tag": "stove",
        "thumb": image_url("soup"),
        "meta": "25 min • 6 steps",
        "steps": ["Chop veggies", "Saute onions", "Add broth", "Simmer", "Season", "Serve"],
    },
    "chickpeacurry": {
        "title": "Chickpea Curry 🍛",
        "tag": "stove veg",
        "thumb": image_url("chickpeacurry"),
        "meta": "30 min • 6 steps",
        "steps": ["Sauté onions", "Add spices", "Add chickpeas", "Add tomatoes", "Simmer", "Serve"],
    },
    "bakedsalmon": {
        "title": "Baked Salmon 🐟",
        "tag": "oven protein",
        "thumb": image_url("bakedsalmon"),
        "meta": "25 min • 5 steps",
        "steps": ["Preheat oven", "Season salmon", "Bake", "Check doneness", "Serve"],
    },
    "bakedmac": {
        "title": "Baked Mac & Cheese 🧀",
        "tag": "oven",
        "thumb": image_url("bakedmac"),
        "meta": "40 min • 6 steps",
        "steps": ["Boil pasta", "Make cheese sauce", "Mix", "Top with crumbs", "Bake", "Serve"],
    },
    "lasagna": {
        "title": "Easy Lasagna 🍅",
        "tag": "oven",
        "thumb": image_url("lasagna"),
        "meta": "60 min • 7 steps",
        "steps": ["Preheat oven", "Layer sauce", "Add noodles", "Add cheese", "Repeat layers", "Bake", "Rest + serve"],
    },
    "cookies": {
        "title": "Simple Cookies 🍪",
        "tag": "oven dessert",
        "thumb": image_url("cookies"),
        "meta": "30 min • 5 steps",
        "steps": ["Mix ingredients", "Scoop dough", "Bake", "Cool", "Enjoy"],
    },
    "brownies": {
        "title": "Fudgy Brownies 🍫",
        "tag": "oven dessert",
        "thumb": image_url("brownies"),
        "meta": "35 min • 6 steps",
        "steps": ["Preheat oven", "Mix batter", "Pour pan", "Bake", "Cool", "Slice"],
    },
    "blueberrymuffins": {
        "title": "Blueberry Muffins 🫐",
        "tag": "oven dessert",
        "thumb": image_url("blueberrymuffins"),
        "meta": "30 min • 6 steps",
        "steps": ["Mix dry", "Mix wet", "Combine", "Fold berries", "Bake", "Cool"],
    },
}


# ---------------- Risk Scoring ----------------
def compute_risk(audio_level: int | None,
                 after_10pm: bool,
                 temp: float | None,
                 manual: bool,
                 distance_cm: float | None = None) -> int:
    risk = 0
    if manual:
        risk += 4

    if audio_level is not None:
        if audio_level >= 95:
            risk += 6
        elif audio_level >= 85:
            risk += 4
        elif audio_level >= 75:
            risk += 2

    if after_10pm:
        risk += 2

    if temp is not None and temp >= 85:
        risk += 1

    if distance_cm is not None and distance_cm <= 10:
        risk += 1

    return max(0, min(risk, 10))


def recipe_for_risk(risk: int) -> str:
    if risk >= 9:
        return "brownies"
    if risk >= 6:
        return "cozysoup"
    if risk >= 3:
        return "stirfry"
    return "garlicpasta"


# ---------------- Routes ----------------
@app.get("/")
def home():
    recipe_list = [
        {"key": key,
         "title": r.get("title", key),
         "tag": r.get("tag", "all"),
         "thumb": r.get("thumb", ""),
         "meta": r.get("meta", "Tap to open steps")}
        for key, r in RECIPES.items()
    ]
    return render_template("home.html", recipe_list=recipe_list)


@app.get("/recipe/<key>")
def recipe(key):
    if key not in RECIPES:
        return redirect(url_for("home"))
    return render_template("recipe.html", recipe=RECIPES[key], key=key)


# --------- Contacts API (max 3) ----------
@app.get("/api/contact")
def api_get_contacts():
    sns_state = {
        "configured": sns_is_configured(),
        "topic_arn": SNS_TOPIC_ARN if sns_is_configured() else None,
        "note": (
            "SNS email requires confirmation from the inbox."
            if sns_is_configured()
            else "Set SNS_TOPIC_ARN to enable SNS."
        )
    }
    return jsonify({
        "ok": True,
        "max": MAX_CONTACTS,
        "contacts": list_contacts(),
        "sns": sns_state
    })


@app.post("/api/contact")
def api_add_contact_route():
    data = request.get_json(force=True) or {}
    name = str(data.get("name", "")).strip()
    method = str(data.get("method", "")).strip().lower()
    value = str(data.get("value", "")).strip()

    if not value:
        return jsonify({"ok": False, "error": "Please enter a phone or email."}), 400
    if method not in {"sms", "email"}:
        return jsonify({"ok": False, "error": "method must be 'sms' or 'email'"}), 400
    if count_contacts() >= MAX_CONTACTS:
        return jsonify({"ok": False, "error": f"Max {MAX_CONTACTS} contacts reached."}), 400
    if contact_exists(method, value):
        return jsonify({"ok": False, "error": "That contact already exists."}), 400

    new_id = add_contact(name, method, value)

    sns_result = None
    if method == "email":
        sub = sns_subscribe_email(value)
        sns_result = {
            "ok": sub["ok"],
            "action": "subscribe",
            "subscription_arn": sub.get("subscription_arn"),
            "error": sub.get("error"),
            "note": "Check inbox and confirm SNS subscription." if sub["ok"] else "SNS subscribe failed."
        }

    return jsonify({
        "ok": True,
        "id": new_id,
        "contacts": list_contacts(),
        "sns": sns_result
    })


@app.delete("/api/contact/<int:contact_id>")
def api_delete_contact_route(contact_id):
    c = get_contact_by_id(contact_id)
    if not c:
        return jsonify({"ok": False, "error": "Contact not found."}), 404

    delete_contact(contact_id)

    # NOTE: We can't reliably unsubscribe without storing SubscriptionArn per contact.
    sns_result = None
    if c.get("method") == "email" and sns_is_configured():
        sns_result = {
            "ok": True,
            "action": "deleted",
            "note": "Removed from app. SNS subscription may still exist unless you store SubscriptionArn per contact."
        }

    return jsonify({"ok": True, "contacts": list_contacts(), "sns": sns_result})


# --------- Live sensor/status panel ----------
@app.get("/api/context")
def api_context():
    conn = db()
    row = conn.execute("SELECT * FROM alerts ORDER BY id DESC LIMIT 1").fetchone()
    conn.close()

    if not row:
        return jsonify({
            "ok": True,
            "last_token": None,
            "threshold": ALERT_THRESHOLD,
        })

    return jsonify({
        "ok": True,
        "last_token": row["token"],
        "risk": row["risk"],
        "audio": row["audio_level"],
        "temp": row["temp"],
        "humidity": row["humidity"],
        "distance": row["distance_cm"],
        "distance_cm": row["distance_cm"],
        "device": row["device_id"],
        "created_at": row["created_at"],
        "public_link": f"/r/{row['token']}",
        "threshold": ALERT_THRESHOLD,
    })


# --------- Trigger endpoint (device posts here) ----------
@app.post("/api/trigger")
def api_trigger():
    data = request.get_json(force=True) or {}

    device_id = str(data.get("device", "K01"))
    trigger_type = str(data.get("trigger", "manual"))
    manual = (trigger_type == "manual")

    audio_level = data.get("audio")
    temp = data.get("temp")
    humidity = data.get("humidity")
    distance_cm = data.get("distance_cm", data.get("distance"))

    hour = datetime.now().hour
    after_10pm = (hour >= 22)

    provided_risk = data.get("risk")
    if provided_risk is None:
        risk = compute_risk(
            audio_level=int(audio_level) if audio_level is not None else None,
            after_10pm=after_10pm,
            temp=float(temp) if temp is not None else None,
            manual=manual,
            distance_cm=float(distance_cm) if distance_cm is not None else None
        )
    else:
        risk = int(provided_risk)

    token = secrets.token_urlsafe(6)
    created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    conn = db()
    conn.execute("""
        INSERT INTO alerts (token, risk, trigger_type, created_at, audio_level, temp, humidity, distance_cm, device_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        token,
        risk,
        trigger_type,
        created_at,
        int(audio_level) if audio_level is not None else None,
        float(temp) if temp is not None else None,
        float(humidity) if humidity is not None else None,
        float(distance_cm) if distance_cm is not None else None,
        device_id
    ))
    conn.commit()
    conn.close()

    recipe_key = recipe_for_risk(risk)
    public_link = f"/r/{token}"

    sns_result = {"ok": False, "message_id": None, "error": "below threshold"}
    if risk >= ALERT_THRESHOLD:
        sns_result = try_publish_sns({
            "token": token,
            "risk": risk,
            "trigger_type": trigger_type,
            "created_at": created_at,
            "audio_level": int(audio_level) if audio_level is not None else None,
            "temp": float(temp) if temp is not None else None,
            "humidity": float(humidity) if humidity is not None else None,
            "distance_cm": float(distance_cm) if distance_cm is not None else None,
            "device_id": device_id,
            "public_link": public_link,
        })

    return jsonify({
        "message": f"{RECIPES[recipe_key]['title']} tip of the day!",
        "link": public_link,
        "recipe_key": recipe_key,
        "risk": risk,
        "threshold": ALERT_THRESHOLD,
        "sns": sns_result,
    })


@app.get("/r/<token>")
def innocent(token):
    conn = db()
    row = conn.execute("SELECT risk FROM alerts WHERE token = ?", (token,)).fetchone()
    conn.close()

    risk = row["risk"] if row else None
    recipe_key = recipe_for_risk(int(risk)) if risk is not None else "garlicpasta"
    return render_template("innocent.html", recipe=RECIPES[recipe_key], recipe_key=recipe_key)


@app.get("/dashboard")
def dashboard():
    conn = db()
    alerts = conn.execute("SELECT * FROM alerts ORDER BY id DESC").fetchall()
    conn.close()

    return render_template(
        "dashboard.html",
        alerts=alerts,
        trusted_contact=list_contacts(),
        threshold=ALERT_THRESHOLD
    )


@app.get("/dev/fire")
def dev_fire():
    return jsonify({
        "tip": "Use curl to trigger events. Example:",
        "curl": """curl -X POST http://127.0.0.1:5050/api/trigger \\
  -H "Content-Type: application/json" \\
  -d '{"trigger":"automatic","audio":92,"temp":78,"humidity":45,"distance_cm":12,"device":"K01"}'"""
    })


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=5050, debug=True)
