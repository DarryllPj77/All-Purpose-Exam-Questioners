"""Mistake Review API rules, against the local database (skipped without one)."""

import secrets
import unittest

try:
    import server
    import db
    db.fetch_one("SELECT 1 AS ok")
    DB_ERROR = None
except Exception as exc:  # pragma: no cover
    DB_ERROR = exc

QUESTIONS = [
    {"text": "2 + 2?", "choices": {"A": "3", "B": "4"}, "answer": ["B"], "maxSelections": 1},
    {"text": "Even numbers", "choices": {"A": "2", "B": "3", "C": "4"}, "answer": ["A", "C"], "maxSelections": 2},
]


@unittest.skipIf(DB_ERROR is not None, f"database not reachable: {DB_ERROR}")
class MistakesApiTest(unittest.TestCase):
    def setUp(self):
        self.names = []
        self.alice, self.bob = self.user(), self.user()
        s = self.alice.post("/api/sets", json={"title": "M", "questions": QUESTIONS}).get_json()["set"]
        self.set_id, self.q1, self.q2 = s["id"], s["questions"][0]["id"], s["questions"][1]["id"]

    def tearDown(self):
        for n in self.names:
            db.execute("DELETE FROM users WHERE username = %s", (n,))

    def user(self):
        name = "apitest_" + secrets.token_hex(4)
        self.names.append(name)
        c = server.app.test_client()
        c.post("/api/auth/register", json={"username": name, "password": secrets.token_hex(8)})
        return c

    def log(self, qid, outcome, mode="exam"):
        self.alice.post(f"/api/progress/{self.set_id}/attempts",
                        json={"attempts": [{"questionId": qid, "mode": mode, "outcome": outcome}]})

    def items(self):
        return {i["questionId"]: i for i in self.alice.get("/api/mistakes").get_json()["items"]}

    def retry(self, qid, selected, **extra):
        return self.alice.post(f"/api/mistakes/{self.set_id}/{qid}/retry",
                               json=dict({"selected": selected}, **extra)).get_json()

    def test_only_incorrect_answers_become_mistakes(self):
        self.log(self.q1, "incorrect")
        for outcome in ("correct", "skipped", "revealed"):
            self.log(self.q2, outcome)
        items = self.items()
        self.assertTrue(items[self.q1]["open"])
        self.assertNotIn(self.q2, items)
        self.assertEqual(items[self.q1]["question"]["text"], "2 + 2?")

    def test_two_correct_retries_resolve_and_history_is_kept(self):
        self.log(self.q1, "incorrect")
        first = self.retry(self.q1, ["B"])
        self.assertEqual((first["correct"], first["open"], first["streak"]), (True, True, 1))
        second = self.retry(self.q1, ["B"])
        self.assertTrue(second["resolved"])
        item = self.items()[self.q1]
        self.assertFalse(item["open"])
        self.assertEqual((item["timesWrong"], item["reviewAttempts"], item["reviewCorrect"]), (1, 2, 2))

    def test_wrong_or_partial_retry_resets_the_streak(self):
        self.log(self.q2, "incorrect")
        self.retry(self.q2, ["A", "C"])
        res = self.retry(self.q2, ["A"])  # partial = incorrect
        self.assertEqual((res["correct"], res["streak"], res["open"]), (False, 0, True))

    def test_new_mistake_reopens_a_resolved_question(self):
        self.log(self.q1, "incorrect")
        self.retry(self.q1, ["B"]); self.retry(self.q1, ["B"])
        self.log(self.q1, "incorrect", mode="practice")
        self.assertTrue(self.items()[self.q1]["open"])

    def test_duplicate_retry_is_not_counted_twice(self):
        self.log(self.q1, "incorrect")
        self.retry(self.q1, ["B"], clientAttemptId="retry_same_123")
        again = self.retry(self.q1, ["B"], clientAttemptId="retry_same_123")
        self.assertTrue(again["duplicate"])
        self.assertEqual(again["streak"], 1)

    def test_reset_closes_items_but_keeps_history(self):
        self.log(self.q1, "incorrect")
        res = self.alice.post("/api/mistakes/reset", json={"setId": self.set_id}).get_json()
        self.assertEqual(res["closed"], 1)
        item = self.items()[self.q1]
        self.assertFalse(item["open"])           # old mistake does not reopen it
        self.assertEqual(item["timesWrong"], 1)  # history kept

    def test_ownership_and_validation(self):
        self.log(self.q1, "incorrect")
        self.assertEqual(self.bob.get(f"/api/mistakes?setId={self.set_id}").status_code, 404)
        self.assertEqual(self.bob.post(f"/api/mistakes/{self.set_id}/{self.q1}/retry",
                                       json={"selected": ["B"]}).status_code, 404)
        bad = self.alice.post(f"/api/mistakes/{self.set_id}/{self.q1}/retry", json={"selected": ["Z"]})
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(self.bob.get("/api/mistakes").get_json()["items"], [])


if __name__ == "__main__":
    unittest.main()
