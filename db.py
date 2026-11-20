"""PostgreSQL connection helpers + schema bootstrap.

Connection is configured via POSTGRES_DSN (local) or DATABASE_URL (Render), e.g.
    POSTGRES_DSN=postgresql://apeq:apeq@localhost:5432/apeq

Connections come from a small per-process pool (Phase 11: opening a new
connection cost ~30 ms per query, and the dashboard made nine). Each
`get_conn()` still gets a connection to itself for the length of the `with`
block and commits or rolls back before handing it back, so callers behave
exactly as before. The pool:
* is created lazily in each process (safe with gunicorn's forked workers);
* is thread-safe (Flask's threaded dev server);
* checks a connection that sat idle for a while before reusing it, and
  drops any connection that broke, so a database restart costs nothing
  more than a reconnect;
* falls back to a plain one-off connection if it is ever exhausted.
DB_POOL_MAX sets its size (default 10); DB_POOL_MAX=0 turns pooling off.
"""

from __future__ import annotations

import os
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import psycopg2
import psycopg2.extras
from psycopg2.extensions import TRANSACTION_STATUS_IDLE
from psycopg2.extensions import connection as PgConnection

SCRIPT_DIR = Path(__file__).resolve().parent
SCHEMA_PATH = SCRIPT_DIR / "schema.sql"

# Reused connections idle longer than this are pinged first (servers and
# proxies close idle connections).
IDLE_CHECK_SECONDS = 60

class _Pool:
    """Idle connections kept for reuse, at most `size` of them open at once."""

    def __init__(self, size: int) -> None:
        self.size = size
        self.pid = os.getpid()
        self.idle: list[tuple[PgConnection, float]] = []  # (connection, last used)
        self.open = 0
        self.lock = threading.Lock()


_pool_lock = threading.Lock()
_pool: _Pool | None = None


def _dsn() -> str:
    dsn = os.getenv("POSTGRES_DSN", "").strip()
    if not dsn:
        dsn = os.getenv("DATABASE_URL", "").strip()
    if not dsn:
        raise RuntimeError(
            "No PostgreSQL DSN found. Set POSTGRES_DSN (local) or DATABASE_URL (Render), e.g.\n"
            "    POSTGRES_DSN=postgresql://apeq:apeq@localhost:5432/apeq"
        )
    return dsn


def _pool_max() -> int:
    try:
        return max(0, int(os.getenv("DB_POOL_MAX", "10")))
    except ValueError:
        return 10


def _get_pool() -> _Pool | None:
    """This process's pool, created on first use (never shared across a fork)."""
    global _pool
    size = _pool_max()
    if size == 0:
        return None
    pid = os.getpid()
    if _pool is not None and _pool.pid == pid and _pool.size == size:
        return _pool
    with _pool_lock:
        if _pool is None or _pool.pid != pid or _pool.size != size:
            # A pool inherited from a parent process is dropped, not closed:
            # its sockets belong to the parent.
            _pool = _Pool(size)
        return _pool


def _alive(conn: PgConnection, last_used: float) -> bool:
    if conn.closed:
        return False
    if time.monotonic() - last_used < IDLE_CHECK_SECONDS:
        return True
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
        conn.rollback()
        return True
    except psycopg2.Error:
        return False


def _borrow() -> tuple[PgConnection, _Pool | None]:
    pool = _get_pool()
    if pool is None:
        return psycopg2.connect(_dsn()), None
    while True:
        with pool.lock:
            item = pool.idle.pop() if pool.idle else None
            if item is None:
                if pool.open >= pool.size:
                    break  # exhausted
                pool.open += 1
        if item is None:
            try:
                return psycopg2.connect(_dsn()), pool
            except Exception:
                with pool.lock:
                    pool.open -= 1
                raise
        conn, last_used = item
        if _alive(conn, last_used):
            return conn, pool
        _discard(conn, pool)
    return psycopg2.connect(_dsn()), None  # exhausted: a one-off connection


def _discard(conn: PgConnection, pool: _Pool) -> None:
    try:
        conn.close()
    finally:
        with pool.lock:
            pool.open -= 1


def _give_back(conn: PgConnection, pool: _Pool | None, broken: bool) -> None:
    if pool is None:
        conn.close()
        return
    if pool is not _pool:  # the pool was closed or replaced meanwhile
        _discard(conn, pool)
        return
    healthy = (not broken and not conn.closed
               and conn.get_transaction_status() == TRANSACTION_STATUS_IDLE)
    if not healthy:
        _discard(conn, pool)
        return
    with pool.lock:
        pool.idle.append((conn, time.monotonic()))


@contextmanager
def get_conn() -> Iterator[PgConnection]:
    """Yield a connection for one unit of work.

    On exception the transaction is rolled back; otherwise it is committed.
    Then the connection goes back to the pool (or is closed if it broke).
    """
    conn, pool = _borrow()
    broken = False
    try:
        yield conn
        conn.commit()
    except Exception as exc:
        broken = isinstance(exc, (psycopg2.OperationalError, psycopg2.InterfaceError))
        try:
            conn.rollback()
        except psycopg2.Error:
            broken = True
        raise
    finally:
        _give_back(conn, pool, broken)


def close_pool() -> None:
    """Close every idle pooled connection and start afresh (tests, shutdown)."""
    global _pool
    with _pool_lock:
        pool, _pool = _pool, None
    if pool is None or pool.pid != os.getpid():
        return
    with pool.lock:
        idle, pool.idle = pool.idle, []
    for conn, _ in idle:
        _discard(conn, pool)


@contextmanager
def cursor() -> Iterator[psycopg2.extras.RealDictCursor]:
    """Convenience: yield a RealDictCursor under a managed connection."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            yield cur


def init_schema() -> None:
    """Apply schema.sql idempotently. Safe to call on every server start."""
    sql = SCHEMA_PATH.read_text(encoding="utf-8")
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql)


def fetch_one(query: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    with cursor() as cur:
        cur.execute(query, params)
        row = cur.fetchone()
        return dict(row) if row else None


def fetch_all(query: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    with cursor() as cur:
        cur.execute(query, params)
        return [dict(r) for r in cur.fetchall()]


def execute(query: str, params: tuple[Any, ...] = ()) -> int:
    with cursor() as cur:
        cur.execute(query, params)
        return cur.rowcount
