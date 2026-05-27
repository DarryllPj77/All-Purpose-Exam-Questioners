"""PostgreSQL connection helpers + schema bootstrap.

Connection is configured via POSTGRES_DSN (local) or DATABASE_URL (Render), e.g.
    POSTGRES_DSN=postgresql://apeq:apeq@localhost:5432/apeq

All operations use short-lived connections; pooling is not needed for the
single-process development server, and keeping things connectionless avoids
cross-thread state in the Flask request handlers.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import psycopg2
import psycopg2.extras
from psycopg2.extensions import connection as PgConnection

SCRIPT_DIR = Path(__file__).resolve().parent
SCHEMA_PATH = SCRIPT_DIR / "schema.sql"


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


@contextmanager
def get_conn() -> Iterator[PgConnection]:
    """Yield a short-lived autocommit-off connection. Caller decides commit/rollback.

    On exception the transaction is rolled back; otherwise it is committed.
    """
    conn = psycopg2.connect(_dsn())
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


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
