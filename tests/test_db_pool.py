"""Connection pool in db.py: reuse, recovery from broken connections, and the
same commit / rollback behaviour as before pooling."""

import os
import threading
import unittest

try:
    import server  # loads .env
    import db
    db.fetch_one("SELECT 1 AS ok")
    DB_ERROR = None
except Exception as exc:  # pragma: no cover
    DB_ERROR = exc


@unittest.skipIf(DB_ERROR is not None, f"database not reachable: {DB_ERROR}")
class PoolTest(unittest.TestCase):
    def setUp(self):
        db.close_pool()
        db.execute("CREATE TEMP TABLE IF NOT EXISTS _pool_probe (n INT)")  # temp: per connection, harmless

    def tearDown(self):
        db.close_pool()

    def backend_pid(self):
        return db.fetch_one("SELECT pg_backend_pid() AS pid")["pid"]

    def test_connections_are_reused(self):
        first = self.backend_pid()
        self.assertEqual(self.backend_pid(), first)

    def test_commit_and_rollback_still_apply(self):
        db.execute("CREATE TABLE IF NOT EXISTS pool_probe_test (n INT)")
        try:
            db.execute("DELETE FROM pool_probe_test")
            with self.assertRaises(ZeroDivisionError):
                with db.cursor() as cur:
                    cur.execute("INSERT INTO pool_probe_test VALUES (1)")
                    1 / 0
            self.assertEqual(db.fetch_one("SELECT COUNT(*) AS n FROM pool_probe_test")["n"], 0)
            db.execute("INSERT INTO pool_probe_test VALUES (2)")
            self.assertEqual(db.fetch_one("SELECT COUNT(*) AS n FROM pool_probe_test")["n"], 1)
        finally:
            db.execute("DROP TABLE IF EXISTS pool_probe_test")

    def test_a_failed_statement_does_not_poison_the_next_borrower(self):
        with self.assertRaises(Exception):
            db.fetch_one("SELECT * FROM table_that_does_not_exist")
        self.assertEqual(db.fetch_one("SELECT 1 AS ok")["ok"], 1)

    def test_a_connection_killed_by_the_server_is_replaced(self):
        victim = self.backend_pid()
        # End that backend from another connection, as a database restart would.
        with db.get_conn() as other:
            pass  # make sure a second pooled connection exists
        import psycopg2
        admin = psycopg2.connect(db._dsn())
        try:
            admin.autocommit = True
            with admin.cursor() as cur:
                cur.execute("SELECT pg_terminate_backend(%s)", (victim,))
        finally:
            admin.close()
        # Force the idle check on the next borrow, then use the pool again.
        db._pool.idle = [(c, 0.0) for c, _ in db._pool.idle]
        for _ in range(3):
            self.assertEqual(db.fetch_one("SELECT 1 AS ok")["ok"], 1)
        self.assertNotEqual(self.backend_pid(), victim)

    def test_threads_share_the_pool_safely(self):
        errors = []

        def work():
            try:
                for _ in range(10):
                    db.fetch_one("SELECT 1 AS ok")
            except Exception as e:  # pragma: no cover
                errors.append(e)

        threads = [threading.Thread(target=work) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])

    def test_pooling_can_be_turned_off(self):
        old = os.environ.get("DB_POOL_MAX")
        os.environ["DB_POOL_MAX"] = "0"
        try:
            db.close_pool()
            self.assertNotEqual(self.backend_pid(), self.backend_pid())
        finally:
            if old is None:
                os.environ.pop("DB_POOL_MAX", None)
            else:
                os.environ["DB_POOL_MAX"] = old


if __name__ == "__main__":
    unittest.main()
