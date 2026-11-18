"""API tests against the real local PostgreSQL (the DSN in .env).

Each test signs up throwaway users named "apitest_<random>" and deletes them
afterwards; every learning row cascades away with them. Skipped when no
database is reachable.
"""

import secrets
import unittest

try:
    import server  # loads .env and applies schema.sql
    import db
    db.fetch_one("SELECT 1 AS ok")
    DB_ERROR = None
except Exception as exc:  # pragma: no cover - environment dependent
    DB_ERROR = exc


def questions():
    return [
        {"number": 1, "text": "2 + 2?", "choices": {"A": "3", "B": "4"}, "answer": ["B"], "maxSelections": 1},
        {"number": 2, "text": "Pick both even numbers", "choices": {"A": "2", "B": "3", "C": "4"},
         "answer": ["A", "C"], "maxSelections": 2},
    ]


@unittest.skipIf(DB_ERROR is not None, f"database not reachable: {DB_ERROR}")
class ProgressApiTest(unittest.TestCase):
    def setUp(self):
        self.usernames = []
        self.alice = self.new_user()
        self.bob = self.new_user()
        res = self.alice.post("/api/sets", json={"title": "API test set", "questions": questions()})
        self.assertEqual(res.status_code, 200, res.get_json())
        self.set = res.get_json()["set"]
        self.set_id = self.set["id"]
        self.qids = [q["id"] for q in self.set["questions"]]

    def tearDown(self):
        for name in self.usernames:
            db.execute("DELETE FROM users WHERE username = %s", (name,))

    def new_user(self):
        name = "apitest_" + secrets.token_hex(4)
        self.usernames.append(name)
        client = server.app.test_client()
        res = client.post("/api/auth/register", json={"username": name, "password": secrets.token_hex(8)})
        self.assertEqual(res.status_code, 200, res.get_json())
        return client

    # ---- question ids -----------------------------------------------------

    def test_saving_a_set_assigns_question_ids(self):
        self.assertEqual(len(self.qids), 2)
        self.assertTrue(all(qid.startswith("q_") for qid in self.qids))
        self.assertEqual(len(set(self.qids)), 2)

    def test_resaving_keeps_ids(self):
        res = self.alice.post("/api/sets", json={
            "id": self.set_id, "title": "renamed", "questions": self.set["questions"]})
        self.assertEqual([q["id"] for q in res.get_json()["set"]["questions"]], self.qids)

    def test_old_sets_are_backfilled_on_read_and_persisted(self):
        uid = db.fetch_one("SELECT owner_id FROM question_sets WHERE id = %s", (self.set_id,))["owner_id"]
        legacy_id = "qs_legacy_" + secrets.token_hex(3)
        from psycopg2.extras import Json
        db.execute(
            "INSERT INTO question_sets (id, owner_id, title, questions, question_count) VALUES (%s,%s,%s,%s,%s)",
            (legacy_id, uid, "legacy", Json(questions()), 2),
        )
        first = self.alice.get(f"/api/sets/{legacy_id}").get_json()["set"]["questions"]
        self.assertTrue(all("id" in q for q in first))
        stored = db.fetch_one("SELECT questions FROM question_sets WHERE id = %s", (legacy_id,))["questions"]
        self.assertEqual([q["id"] for q in stored], [q["id"] for q in first])

    # ---- config -------------------------------------------------------------

    def test_config_requires_sign_in(self):
        self.assertEqual(server.app.test_client().get("/api/learning/config").status_code, 401)

    def test_config_lists_modes(self):
        cfg = self.alice.get("/api/learning/config").get_json()["config"]
        self.assertIn("flashcards", cfg["modes"])
        self.assertEqual(cfg["srs"]["intervalsDays"][0], 1)

    # ---- attempts -------------------------------------------------------------

    def attempt(self, **overrides):
        base = {"questionId": self.qids[0], "mode": "learn", "outcome": "correct", "response": {"selected": ["B"]}}
        base.update(overrides)
        return base

    def test_record_and_list_attempts(self):
        res = self.alice.post(f"/api/progress/{self.set_id}/attempts", json={"attempts": [
            self.attempt(), self.attempt(questionId=self.qids[1], outcome="incorrect")]})
        self.assertEqual(res.get_json(), {"ok": True, "recorded": 2, "duplicates": 0})
        listed = self.alice.get(f"/api/progress/{self.set_id}/attempts").get_json()["attempts"]
        self.assertEqual(len(listed), 2)
        only_first = self.alice.get(
            f"/api/progress/{self.set_id}/attempts?questionId={self.qids[0]}").get_json()["attempts"]
        self.assertEqual([a["questionId"] for a in only_first], [self.qids[0]])

    def test_retried_attempt_is_not_double_counted(self):
        body = {"attempts": [self.attempt(clientAttemptId="retry_same_12345")]}
        self.alice.post(f"/api/progress/{self.set_id}/attempts", json=body)
        again = self.alice.post(f"/api/progress/{self.set_id}/attempts", json=body).get_json()
        self.assertEqual((again["recorded"], again["duplicates"]), (0, 1))
        listed = self.alice.get(f"/api/progress/{self.set_id}/attempts").get_json()["attempts"]
        self.assertEqual(len(listed), 1)

    def test_rejects_question_not_in_set(self):
        res = self.alice.post(f"/api/progress/{self.set_id}/attempts",
                              json={"attempts": [self.attempt(questionId="q_notinthisset")]})
        self.assertEqual(res.status_code, 400)

    def test_rejects_unknown_mode_and_outcome(self):
        for bad in (self.attempt(mode="cheat"), self.attempt(outcome="great")):
            res = self.alice.post(f"/api/progress/{self.set_id}/attempts", json={"attempts": [bad]})
            self.assertEqual(res.status_code, 400)

    def test_rejected_batch_writes_nothing(self):
        self.alice.post(f"/api/progress/{self.set_id}/attempts",
                        json={"attempts": [self.attempt(), self.attempt(mode="cheat")]})
        self.assertEqual(self.alice.get(f"/api/progress/{self.set_id}/attempts").get_json()["attempts"], [])

    def test_other_users_cannot_read_or_write(self):
        self.assertEqual(self.bob.get(f"/api/progress/{self.set_id}").status_code, 404)
        self.assertEqual(self.bob.get(f"/api/progress/{self.set_id}/attempts").status_code, 404)
        res = self.bob.post(f"/api/progress/{self.set_id}/attempts", json={"attempts": [self.attempt()]})
        self.assertEqual(res.status_code, 404)
        self.assertEqual(self.bob.get(f"/api/study-sessions/{self.set_id}/flashcards").status_code, 404)

    def test_progress_starts_empty(self):
        res = self.alice.get(f"/api/progress/{self.set_id}").get_json()
        self.assertEqual(res["progress"], [])

    # ---- flashcards -----------------------------------------------------------

    def flashcard(self, client, qid, status):
        return client.put(f"/api/progress/{self.set_id}/flashcards/{qid}", json={"status": status})

    def test_flashcard_status_set_change_and_clear(self):
        qid = self.qids[0]
        self.assertEqual(self.flashcard(self.alice, qid, "know").get_json()["status"], "know")
        self.assertEqual(self.flashcard(self.alice, qid, "learning").get_json()["status"], "learning")
        rows = {p["questionId"]: p for p in self.alice.get(f"/api/progress/{self.set_id}").get_json()["progress"]}
        self.assertEqual(rows[qid]["flashcard"]["status"], "learning")
        self.assertIsNone(self.flashcard(self.alice, qid, None).get_json()["status"])

    def test_flashcard_status_leaves_other_modes_alone(self):
        qid = self.qids[0]
        self.flashcard(self.alice, qid, "know")
        row = self.alice.get(f"/api/progress/{self.set_id}").get_json()["progress"][0]
        self.assertIsNone(row["learn"]["stage"])
        self.assertEqual(row["learn"]["streak"], 0)
        self.assertIsNone(row["review"]["dueAt"])
        self.assertFalse(row["mistake"]["open"])

    def test_flashcard_status_validation(self):
        self.assertEqual(self.flashcard(self.alice, self.qids[0], "mastered").status_code, 400)
        self.assertEqual(self.flashcard(self.alice, "q_notinthisset", "know").status_code, 400)
        self.assertEqual(self.flashcard(self.bob, self.qids[0], "know").status_code, 404)

    # ---- practice results in history -----------------------------------------

    def practice_result(self, **overrides):
        body = {
            "mode": "Practice", "setId": self.set_id, "score": 50, "correct": 1, "total": 2,
            "config": {"count": 2, "passPercent": 70, "timerMinutes": None},
            "durationSeconds": 95, "clientAttemptId": "p_" + secrets.token_hex(8),
        }
        body.update(overrides)
        return body

    def test_practice_result_is_saved_with_settings_and_time(self):
        res = self.alice.post("/api/history", json=self.practice_result())
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertFalse(res.get_json()["duplicate"])
        entry = self.alice.get("/api/history").get_json()["history"][0]
        self.assertEqual(entry["mode"], "Practice")
        self.assertEqual(entry["durationSeconds"], 95)
        self.assertEqual(entry["config"]["passPercent"], 70)

    def test_same_attempt_id_never_creates_a_second_row(self):
        body = self.practice_result()
        first = self.alice.post("/api/history", json=body).get_json()
        again = self.alice.post("/api/history", json=body).get_json()
        self.assertTrue(again["duplicate"])
        self.assertEqual(first["entry"]["id"], again["entry"]["id"])
        rows = [h for h in self.alice.get("/api/history").get_json()["history"] if h["mode"] == "Practice"]
        self.assertEqual(len(rows), 1)

    def test_attempt_ids_are_per_user(self):
        shared = "p_" + secrets.token_hex(8)
        self.alice.post("/api/history", json=self.practice_result(clientAttemptId=shared))
        bob_set = self.bob.post("/api/sets", json={"title": "b", "questions": questions()}).get_json()["set"]["id"]
        res = self.bob.post("/api/history", json=self.practice_result(setId=bob_set, clientAttemptId=shared))
        self.assertFalse(res.get_json()["duplicate"])

    def test_practice_result_validation(self):
        for bad in ({"mode": "Cheat"}, {"config": [1]}, {"config": {"x": "y" * 3000}},
                    {"durationSeconds": -1}, {"durationSeconds": 10 ** 7}, {"clientAttemptId": "bad id!"}):
            res = self.alice.post("/api/history", json=self.practice_result(**bad))
            self.assertEqual(res.status_code, 400, bad)

    def test_exam_history_still_works_without_new_fields(self):
        res = self.alice.post("/api/history", json={
            "mode": "Exam", "setId": self.set_id, "score": 100, "correct": 2, "total": 2})
        self.assertEqual(res.status_code, 200, res.get_json())
        entry = self.alice.get("/api/history").get_json()["history"][0]
        self.assertIsNone(entry["durationSeconds"])

    # ---- study sessions -------------------------------------------------------

    def test_study_session_round_trip(self):
        url = f"/api/study-sessions/{self.set_id}/flashcards"
        self.assertIsNone(self.alice.get(url).get_json()["state"])
        state = {"order": self.qids, "index": 1}
        self.assertEqual(self.alice.put(url, json={"state": state}).status_code, 200)
        self.assertEqual(self.alice.get(url).get_json()["state"], state)
        self.alice.put(url, json={"state": {"order": self.qids, "index": 0}})
        self.assertEqual(self.alice.get(url).get_json()["state"]["index"], 0)
        self.alice.delete(url)
        self.assertIsNone(self.alice.get(url).get_json()["state"])

    def test_study_session_validation(self):
        base = f"/api/study-sessions/{self.set_id}"
        self.assertEqual(self.alice.get(f"{base}/unknownmode").status_code, 400)
        self.assertEqual(self.alice.put(f"{base}/learn", json={"state": [1, 2]}).status_code, 400)
        huge = {"blob": "x" * 210_000}
        self.assertEqual(self.alice.put(f"{base}/learn", json={"state": huge}).status_code, 400)

    def test_deleting_a_set_removes_its_learning_data(self):
        self.alice.post(f"/api/progress/{self.set_id}/attempts", json={"attempts": [self.attempt()]})
        self.alice.put(f"/api/study-sessions/{self.set_id}/learn", json={"state": {"i": 1}})
        self.alice.delete(f"/api/sets/{self.set_id}")
        left = db.fetch_one(
            "SELECT (SELECT COUNT(*) FROM question_attempts WHERE set_id = %s) +"
            "       (SELECT COUNT(*) FROM study_sessions WHERE set_id = %s) AS n",
            (self.set_id, self.set_id),
        )
        self.assertEqual(left["n"], 0)


@unittest.skipIf(DB_ERROR is not None, f"database not reachable: {DB_ERROR}")
class StaticFilesTest(unittest.TestCase):
    def test_only_app_files_are_served(self):
        client = server.app.test_client()
        for path in ("/", "/Cert.css", "/Cert.js", "/questions.js", "/js/core/learning.js", "/js/shell.js",
                     "/js/modes/flashcards.js", "/js/modes/practice.js",
                     "/js/modes/mistakes.js", "/js/modes/learn.js",
                     "/js/modes/recall.js"):
            with client.get(path) as res:
                self.assertEqual(res.status_code, 200, path)
        for path in ("/.env", "/server.py", "/schema.sql", "/.git/config", "/learning_config.py",
                     "/tests/test_progress_api.py", "/js/../.env"):
            self.assertEqual(client.get(path).status_code, 404, path)


if __name__ == "__main__":
    unittest.main()
