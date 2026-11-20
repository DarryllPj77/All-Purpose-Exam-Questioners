"""Phase 11 integration checks across modes: each mode writes the right
records for the right set and user, and the measures stay independent."""

import secrets
import unittest

try:
    import server
    import db
    db.fetch_one("SELECT 1 AS ok")
    DB_ERROR = None
except Exception as exc:  # pragma: no cover
    DB_ERROR = exc

MANILA = -480
QUESTIONS = [
    {"text": "2 + 2?", "choices": {"A": "3", "B": "4"}, "answer": ["B"]},
    {"text": "Capital of France?", "choices": {"A": "Paris", "B": "Rome"}, "answer": ["A"]},
    {"text": "Largest planet?", "choices": {"A": "Mars", "B": "Jupiter"}, "answer": ["B"]},
]


@unittest.skipIf(DB_ERROR is not None, f"database not reachable: {DB_ERROR}")
class IntegrationTest(unittest.TestCase):
    def setUp(self):
        self.names = []
        self.alice, self.bob = self.user(), self.user()
        a = self.alice.post("/api/sets", json={"title": "Alice A", "questions": QUESTIONS}).get_json()["set"]
        b = self.alice.post("/api/sets", json={"title": "Alice B", "questions": QUESTIONS}).get_json()["set"]
        self.a, self.b = a["id"], b["id"]
        self.qa = [q["id"] for q in a["questions"]]
        self.qb = [q["id"] for q in b["questions"]]
        bob = self.bob.post("/api/sets", json={"title": "Bob's", "questions": QUESTIONS}).get_json()["set"]
        self.bob_set = bob["id"]

    def tearDown(self):
        for n in self.names:
            db.execute("DELETE FROM users WHERE username = %s", (n,))

    def user(self):
        name = "apitest_" + secrets.token_hex(4)
        self.names.append(name)
        c = server.app.test_client()
        c.post("/api/auth/register", json={"username": name, "password": secrets.token_hex(8)})
        return c

    def progress(self, set_id, client=None):
        rows = (client or self.alice).get(f"/api/progress/{set_id}").get_json()["progress"]
        return {r["questionId"]: r for r in rows}

    def learn(self, set_id, qid, selected, client=None):
        return (client or self.alice).post(f"/api/learn/{set_id}/{qid}/answer",
                                           json={"format": "choice", "selected": selected})

    def open_mistakes(self, client=None):
        items = (client or self.alice).get("/api/mistakes").get_json()["items"]
        return {(i["setId"], i["questionId"]) for i in items if i["open"]}

    # ---- Learn updates the right progress record -------------------------------

    def test_learn_updates_only_its_own_set_question_and_user(self):
        # The same question exists in two of Alice's sets and in Bob's set.
        self.assertEqual(self.qa, self.qb)
        for _ in range(3):
            self.assertEqual(self.learn(self.a, self.qa[0], ["B"]).status_code, 200)
        a = self.progress(self.a)
        self.assertEqual((a[self.qa[0]]["learn"]["stage"], a[self.qa[0]]["learn"]["streak"]), ("mastered", 3))
        self.assertNotIn(self.qa[1], a)
        self.assertEqual(self.progress(self.b), {})          # same question, other set: untouched
        self.assertEqual(self.progress(self.bob_set, self.bob), {})  # other user: untouched

    # ---- Mistake Review uses the real answer history ---------------------------

    def test_mistakes_come_only_from_recorded_incorrect_answers(self):
        self.assertEqual(self.open_mistakes(), set())
        self.learn(self.a, self.qa[0], ["B"])  # correct: no mistake
        self.alice.post(f"/api/progress/{self.a}/attempts", json={"attempts": [
            {"questionId": self.qa[1], "mode": "flashcards", "outcome": "revealed"},
            {"questionId": self.qa[2], "mode": "practice", "outcome": "skipped"},
        ]})
        self.assertEqual(self.open_mistakes(), set())  # reveals and skips are not mistakes
        self.learn(self.a, self.qa[1], ["B"])  # wrong
        self.assertEqual(self.open_mistakes(), {(self.a, self.qa[1])})
        items = self.alice.get("/api/mistakes").get_json()["items"]
        self.assertEqual(items[0]["lastWrongMode"], "learn")
        self.assertEqual(self.open_mistakes(self.bob), set())

    # ---- Smart Review schedules studied questions ------------------------------

    def test_review_schedules_what_was_studied_in_other_modes(self):
        self.learn(self.a, self.qa[0], ["B"])
        ov = self.alice.get(f"/api/review/overview?tzOffset={MANILA}").get_json()
        self.assertEqual([(i["setId"], i["questionId"]) for i in ov["dueItems"]], [(self.a, self.qa[0])])
        res = self.alice.post(f"/api/review/{self.a}/{self.qa[0]}/answer",
                              json={"format": "choice", "selected": ["B"], "tzOffset": MANILA}).get_json()
        self.assertEqual((res["outcome"], res["intervalDays"]), ("correct", 1))
        self.assertEqual(self.alice.get(f"/api/review/overview?tzOffset={MANILA}").get_json()["counts"]["due"], 0)

    # ---- Practice history stays as it was --------------------------------------

    def test_practice_history_survives_set_edits_and_deletion(self):
        body = {"mode": "Practice", "setId": self.a, "score": 67, "correct": 2, "total": 3,
                "config": {"count": 3, "passPercent": 70, "timerMinutes": None},
                "durationSeconds": 40, "clientAttemptId": "p_" + secrets.token_hex(8)}
        self.assertEqual(self.alice.post("/api/history", json=body).status_code, 200)
        self.alice.post("/api/sets", json={"id": self.a, "title": "Renamed", "questions": QUESTIONS[:1]})
        self.alice.delete(f"/api/sets/{self.a}")
        entry = next(h for h in self.alice.get("/api/history").get_json()["history"] if h["mode"] == "Practice")
        self.assertEqual((entry["score"], entry["correct"], entry["total"]), (67, 2, 3))
        self.assertEqual(entry["config"]["passPercent"], 70)

    # ---- Flashcard labels stay separate ----------------------------------------

    def test_flashcard_labels_change_nothing_else(self):
        self.alice.put(f"/api/progress/{self.a}/flashcards/{self.qa[0]}", json={"status": "know"})
        row = self.progress(self.a)[self.qa[0]]
        self.assertEqual(row["flashcard"]["status"], "know")
        self.assertIsNone(row["learn"]["stage"])
        self.assertFalse(row["mistake"]["open"])
        self.assertIsNone(row["review"]["lastReviewedAt"])
        # And a wrong Learn answer does not move the flashcard label.
        self.learn(self.a, self.qa[0], ["A"])
        self.assertEqual(self.progress(self.a)[self.qa[0]]["flashcard"]["status"], "know")
        d = self.alice.get(f"/api/dashboard?tzOffset={MANILA}").get_json()
        s = next(x for x in d["sets"] if x["setId"] == self.a)
        self.assertEqual((s["flashcards"]["know"], s["learn"]["mastered"]), (1, 0))

    # ---- Every mode refuses another user's set ---------------------------------

    def test_no_mode_can_read_or_write_another_users_set(self):
        a, q = self.a, self.qa[0]
        bob = self.bob
        calls = [
            bob.get(f"/api/sets/{a}"),
            bob.get(f"/api/progress/{a}"),
            bob.get(f"/api/progress/{a}/attempts"),
            bob.post(f"/api/progress/{a}/attempts", json={"attempts": [{"questionId": q, "mode": "exam", "outcome": "correct"}]}),
            bob.put(f"/api/progress/{a}/flashcards/{q}", json={"status": "know"}),
            bob.get(f"/api/study-sessions/{a}/learn"),
            bob.put(f"/api/study-sessions/{a}/learn", json={"state": {"v": 1}}),
            bob.post(f"/api/learn/{a}/{q}/answer", json={"format": "choice", "selected": ["B"]}),
            bob.post(f"/api/recall/{a}/{q}/rate", json={"rating": "correct"}),
            bob.post(f"/api/review/{a}/{q}/answer", json={"format": "choice", "selected": ["B"], "tzOffset": 0}),
            bob.post(f"/api/mistakes/{a}/{q}/retry", json={"selected": ["B"]}),
            bob.post(f"/api/code/{a}/{q}/answer", json={"format": "choice", "selected": ["B"]}),
            bob.delete(f"/api/sets/{a}"),
        ]
        statuses = [r.status_code for r in calls]
        self.assertTrue(all(s in (403, 404) for s in statuses), statuses)
        # Alice's set and data are intact afterwards.
        self.assertEqual(self.alice.get(f"/api/sets/{a}").status_code, 200)
        self.assertEqual(self.progress(a), {})

    def test_signed_out_requests_are_refused(self):
        anon = server.app.test_client()
        for path in ("/api/sets", f"/api/progress/{self.a}", "/api/mistakes", "/api/dashboard",
                     "/api/review/overview", "/api/history", "/api/learning/config"):
            self.assertEqual(anon.get(path).status_code, 401, path)


if __name__ == "__main__":
    unittest.main()
