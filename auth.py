"""Authentication: register, login, logout, current-user check.

Uses Flask's signed-cookie sessions to remember the logged-in user id.
Passwords are hashed with werkzeug.security (pbkdf2:sha256 with per-user salt).
"""

from __future__ import annotations

import re
from functools import wraps
from typing import Any

from flask import Blueprint, current_app, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from billing import ensure_usage_row, usage_summary
from db import fetch_one, execute

bp = Blueprint("auth", __name__)

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
PASSWORD_MIN_LEN = 6


def current_user_id() -> int | None:
    uid = session.get("uid")
    return int(uid) if uid else None


def current_user() -> dict[str, Any] | None:
    uid = current_user_id()
    if not uid:
        return None
    return fetch_one(
        "SELECT id, username, email, plan_tier, created_at FROM users WHERE id = %s",
        (uid,),
    )


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not current_user_id():
            return jsonify({"ok": False, "error": "Not signed in."}), 401
        return fn(*args, **kwargs)
    return wrapper


def _serialize_user(row: dict[str, Any], usage: dict[str, Any] | None = None) -> dict[str, Any]:
    data = {
        "id": row["id"],
        "username": row["username"],
        "email": row.get("email"),
        "planTier": (row.get("plan_tier") or "free").lower(),
    }
    if usage:
        data["usage"] = usage
    return data


def _validate_credentials(payload: dict[str, Any]) -> tuple[str, str, str | None] | tuple[None, None, None]:
    """Return (username, password, email) or (None, None, None) — caller checks."""
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    email = (payload.get("email") or "").strip() or None
    if not username or not password:
        return (None, None, None)
    return (username, password, email)


@bp.route("/api/auth/me", methods=["GET"])
def me():
    user = current_user()
    if not user:
        return jsonify({"ok": False, "error": "Not signed in."}), 401
    usage = usage_summary(user["id"], user.get("plan_tier"))
    return jsonify({"ok": True, "user": _serialize_user(user, usage)})


@bp.route("/api/auth/register", methods=["POST", "OPTIONS"])
def register():
    if request.method == "OPTIONS":
        return ("", 204)
    current_app.logger.info("POST /api/auth/register")
    payload = request.get_json(silent=True) or {}
    username, password, email = _validate_credentials(payload)
    if not username:
        return jsonify({"ok": False, "error": "Username and password are required."}), 400
    if not USERNAME_RE.match(username):
        return jsonify({
            "ok": False,
            "error": "Username must be 3–32 chars, letters/numbers/._- only."
        }), 400
    if len(password) < PASSWORD_MIN_LEN:
        return jsonify({
            "ok": False,
            "error": f"Password must be at least {PASSWORD_MIN_LEN} characters."
        }), 400

    existing = fetch_one("SELECT id FROM users WHERE username = %s", (username,))
    if existing:
        return jsonify({"ok": False, "error": "That username is taken."}), 409

    password_hash = generate_password_hash(password)
    row = fetch_one(
        "INSERT INTO users (username, email, password_hash) "
        "VALUES (%s, %s, %s) "
        "RETURNING id, username, email, plan_tier, created_at",
        (username, email, password_hash),
    )
    if not row:
        return jsonify({"ok": False, "error": "Failed to create account."}), 500
    ensure_usage_row(int(row["id"]))

    session.clear()
    session["uid"] = row["id"]
    session.permanent = True
    usage = usage_summary(int(row["id"]), row.get("plan_tier"))
    return jsonify({"ok": True, "user": _serialize_user(row, usage)})


@bp.route("/api/auth/login", methods=["POST", "OPTIONS"])
def login():
    if request.method == "OPTIONS":
        return ("", 204)
    payload = request.get_json(silent=True) or {}
    username, password, _ = _validate_credentials(payload)
    if not username:
        return jsonify({"ok": False, "error": "Username and password are required."}), 400

    row = fetch_one(
        "SELECT id, username, email, password_hash, plan_tier FROM users WHERE username = %s",
        (username,),
    )
    if not row or not check_password_hash(row["password_hash"], password):
        return jsonify({"ok": False, "error": "Invalid username or password."}), 401

    session.clear()
    session["uid"] = row["id"]
    session.permanent = True
    usage = usage_summary(int(row["id"]), row.get("plan_tier"))
    return jsonify({"ok": True, "user": _serialize_user(row, usage)})


@bp.route("/api/auth/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})
