"""Local HTTP server for the All Purpose Exam Questioners reviewer app.

Routes:
  GET  /                               → serves Index.html
  GET  /<file>                         → serves any project file

  POST /api/auth/register              → create account + sign in
  POST /api/auth/login                 → sign in
  POST /api/auth/logout                → sign out
  GET  /api/auth/me                    → who am I (401 if signed-out)

  GET    /api/sets                     → list current user's question sets
  POST   /api/sets                     → upsert a set
  GET    /api/sets/<id>                → full set
  DELETE /api/sets/<id>                → delete a set
  POST   /api/sets/<id>/stats          → record a practice score
  GET/PUT /api/active-set              → which set powers the quiz
  GET/POST/DELETE /api/history         → session history (per user)
  GET/PUT/DELETE /api/active-session   → in-progress session state

  POST /api/analyze                    → PDF analysis (login required)
  POST /api/generate                   → submit generation job (login required)
  GET  /api/generate/status/<jobId>    → job progress + result

All API routes that touch user data require a signed-in session.
The OpenRouter API key stays server-side (loaded from .env by backend.generate).

Run:
    pip install -r requirements.txt   # flask, psycopg2-binary, etc.
    # set POSTGRES_DSN and FLASK_SECRET_KEY in .env
    python server.py
    # then open http://127.0.0.1:5000/
"""

from __future__ import annotations

import os
import secrets
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from psycopg2.extras import Json

from backend import DEFAULT_OUTPUT, SCRIPT_DIR, analyze, generate
from billing import increment_usage, plan_limits, usage_summary
from auth import bp as auth_bp, current_user_id, login_required
from data_routes import bp as data_bp, _new_set_id
from db import cursor, execute, fetch_one, init_schema

# Load .env before reading any env var.
load_dotenv(SCRIPT_DIR / ".env")

MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB
JOB_RETENTION_SECONDS = 60 * 30      # keep finished jobs for 30 min

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES
app.config["SECRET_KEY"] = os.getenv("FLASK_SECRET_KEY") or secrets.token_hex(32)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=30)

# Make sure the DB schema exists before serving any request.
try:
    init_schema()
    print("DB schema is up to date.")
except Exception as e:  # noqa: BLE001 — surface early on misconfig
    print(f"WARNING: schema init failed: {e}")

app.register_blueprint(auth_bp)
app.register_blueprint(data_bp)


@app.after_request
def _allow_cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = request.headers.get("Origin", "*")
    resp.headers["Access-Control-Allow-Credentials"] = "true"
    resp.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS, PUT, DELETE"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


# ============================================================
# Static
# ============================================================

@app.route("/", methods=["GET"])
def index():
    return send_from_directory(SCRIPT_DIR, "Index.html")


@app.route("/<path:filename>", methods=["GET"])
def static_files(filename: str):
    safe = (SCRIPT_DIR / filename).resolve()
    if SCRIPT_DIR not in safe.parents and safe != SCRIPT_DIR:
        return jsonify({"ok": False, "error": "Forbidden"}), 403
    return send_from_directory(SCRIPT_DIR, filename)


# ============================================================
# Upload helpers
# ============================================================

def _save_upload_to_temp(upload) -> Path:
    if not upload or not upload.filename:
        raise ValueError("Empty upload.")
    if not upload.filename.lower().endswith(".pdf"):
        raise ValueError("Only .pdf files are allowed.")
    fd, tmp_name = tempfile.mkstemp(prefix="upload-", suffix=".pdf", dir=str(SCRIPT_DIR))
    os.close(fd)
    tmp_path = Path(tmp_name)
    upload.save(str(tmp_path))
    if tmp_path.stat().st_size == 0:
        try:
            tmp_path.unlink()
        except OSError:
            pass
        raise ValueError("Uploaded PDF is empty.")
    return tmp_path


# ============================================================
# JobManager — background generation jobs (now PG-backed)
# ============================================================

class JobManager:
    def __init__(self, max_workers: int = 2) -> None:
        self._jobs: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="gen-job")

    def submit(self, owner_id: int, pdf_path: Path, count: Optional[int],
               filename: str) -> str:
        self._gc_locked()
        job_id = uuid.uuid4().hex[:16]
        now = time.time()
        with self._lock:
            self._jobs[job_id] = {
                "id": job_id,
                "ownerId": owner_id,
                "state": "pending",
                "phase": "queued",
                "message": "Queued for processing…",
                "percent": 0,
                "startedAt": now,
                "finishedAt": None,
                "elapsedSeconds": 0,
                "error": None,
                "requested": count,
                "produced": None,
                "sections": None,
                "setId": None,        # populated when DB write succeeds
                "filename": filename,
            }
        self._executor.submit(self._run, job_id, owner_id, pdf_path, count, filename)
        return job_id

    def get(self, job_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            snapshot = dict(job)
        end = snapshot["finishedAt"] or time.time()
        snapshot["elapsedSeconds"] = round(end - snapshot["startedAt"], 1)
        return snapshot

    def _update(self, job_id: str, **fields: Any) -> None:
        with self._lock:
            if job_id in self._jobs:
                self._jobs[job_id].update(fields)

    def _gc_locked(self) -> None:
        cutoff = time.time() - JOB_RETENTION_SECONDS
        with self._lock:
            dead = [
                jid for jid, j in self._jobs.items()
                if j.get("finishedAt") and j["finishedAt"] < cutoff
            ]
            for jid in dead:
                self._jobs.pop(jid, None)

    def _persist_set(
        self,
        owner_id: int,
        filename: str,
        questions: list[dict[str, Any]],
        requested: int,
        produced: int,
        sections: int,
        total_words: int,
    ) -> str:
        """Write the generated set into PostgreSQL and mark it active."""
        set_id = _new_set_id()
        title_base = filename.rsplit("/", 1)[-1] if filename else "Generated set"
        title = title_base.rsplit(".pdf", 1)[0].replace("_", " ").replace("-", " ").strip() or "Generated set"
        title = title[:200]
        source = {
            "type": "pdf-generated",
            "filename": filename or None,
            "requestedCount": requested,
            "producedCount": produced,
            "sections": sections,
            "totalWords": total_words,
            "generatorModel": "deepseek/deepseek-chat",
        }
        stats = {
            "sessionsRun": 0,
            "lastPlayedAt": None,
            "bestScore": None,
            "averageScore": None,
        }
        with cursor() as cur:
            cur.execute(
                """
                INSERT INTO question_sets (id, owner_id, title, source,
                                           questions, question_count, stats)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (set_id, owner_id, title, Json(source), Json(questions),
                 len(questions), Json(stats)),
            )
            cur.execute(
                "INSERT INTO user_active_set (owner_id, set_id) VALUES (%s, %s) "
                "ON CONFLICT (owner_id) DO UPDATE SET set_id = EXCLUDED.set_id, updated_at = NOW()",
                (owner_id, set_id),
            )
        increment_usage(owner_id, produced)
        return set_id

    def _run(self, job_id: str, owner_id: int, pdf_path: Path,
             count: Optional[int], filename: str) -> None:
        def progress(phase: str, message: str, percent: int) -> None:
            self._update(job_id, state="running", phase=phase, message=message, percent=percent)

        try:
            # output_path=None → backend skips the questions.js side-file write.
            # We persist to PostgreSQL instead, scoped to the owning user.
            result = generate(pdf_path, output_path=None, count=count, progress=progress)
            set_id = self._persist_set(
                owner_id=owner_id,
                filename=filename,
                questions=result["questions"],
                requested=result["requested"],
                produced=result["produced"],
                sections=result["sections"],
                total_words=result["totalWords"],
            )
            self._update(
                job_id,
                state="done",
                phase="done",
                message=f"Saved {result['produced']} of {result['requested']} requested questions.",
                percent=100,
                finishedAt=time.time(),
                produced=result["produced"],
                sections=result["sections"],
                requested=result["requested"],
                setId=set_id,
            )
        except Exception as e:  # noqa: BLE001
            self._update(
                job_id,
                state="error",
                phase="error",
                message="Generation failed.",
                error=str(e),
                finishedAt=time.time(),
            )
        finally:
            try:
                pdf_path.unlink()
            except OSError:
                pass


job_manager = JobManager()


# ============================================================
# Analyze + Generate routes
# ============================================================

@app.route("/api/analyze", methods=["POST", "OPTIONS"])
@login_required
def api_analyze():
    if request.method == "OPTIONS":
        return ("", 204)

    if "pdf" not in request.files:
        return jsonify({"ok": False, "error": 'No file uploaded (expected field "pdf").'}), 400

    try:
        tmp_path = _save_upload_to_temp(request.files["pdf"])
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    try:
        result = analyze(tmp_path)
        return jsonify(result)
    except (RuntimeError, ValueError, FileNotFoundError) as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"Unexpected error: {e}"}), 500
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass


@app.route("/api/generate", methods=["POST", "OPTIONS"])
@login_required
def api_generate():
    if request.method == "OPTIONS":
        return ("", 204)

    owner_id = current_user_id()
    user = fetch_one("SELECT id, plan_tier FROM users WHERE id = %s", (owner_id,))
    if not user:
        return jsonify({"ok": False, "error": "Not signed in."}), 401
    limits = plan_limits(user.get("plan_tier"))
    usage = usage_summary(owner_id, user.get("plan_tier"))
    if usage["generationsUsed"] >= usage["generationsLimit"]:
        return jsonify({
            "ok": False,
            "code": "USAGE_LIMIT",
            "error": "You have reached your monthly generation limit. Please upgrade your plan.",
            "usage": usage,
        }), 403

    if "pdf" not in request.files:
        return jsonify({"ok": False, "error": 'No file uploaded (expected field "pdf").'}), 400

    count: Optional[int] = None
    count_raw = request.form.get("count")
    if count_raw:
        try:
            count = int(count_raw)
        except ValueError:
            return jsonify({"ok": False, "error": "count must be an integer."}), 400
        max_q = int(limits["max_questions_per_gen"])
        if count < 1 or count > max_q:
            return jsonify({
                "ok": False,
                "code": "PLAN_QUESTION_LIMIT",
                "error": f"Your plan allows up to {max_q} questions per generation.",
                "usage": usage,
            }), 403
    else:
        count = int(limits["max_questions_per_gen"])

    upload = request.files["pdf"]
    filename = upload.filename or "upload.pdf"
    try:
        tmp_path = _save_upload_to_temp(upload)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    job_id = job_manager.submit(owner_id, tmp_path, count, filename)
    return jsonify({"ok": True, "jobId": job_id})


@app.route("/api/generate/status/<job_id>", methods=["GET"])
@login_required
def api_generate_status(job_id: str):
    job = job_manager.get(job_id)
    if not job:
        return jsonify({"ok": False, "error": "Job not found (it may have expired)."}), 404
    if job.get("ownerId") and job["ownerId"] != current_user_id():
        # Don't leak status of another user's job.
        return jsonify({"ok": False, "error": "Job not found (it may have expired)."}), 404
    # Strip ownerId from the wire response.
    j = {k: v for k, v in job.items() if k != "ownerId"}
    return jsonify({"ok": True, "job": j})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=False)
