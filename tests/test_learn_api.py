"""Learn mode: text matching (no database) and the answer API (local database)."""

import secrets
import unittest

from learn_routes import next_progress, normalize_text, written_answer

try:
    import server
    import db
    db.fetch_one("SELECT 1 AS ok")
    DB_ERROR = None
except Exception as exc:  # pragma: no cover
    DB_ERROR = exc


# Shared with tests/js/learn.test.js: both implementations must agree.
NORMALIZE_CASES = [
    ("Paris", "paris"),
    ("  the Paris!! ", "paris"),
    ("The  Great   Wall", "great wall"),
    ("An apple", "apple"),
    ("a", "a"),
    ("“HTTP/2”", "http 2"),
    ("Don't", "dont"),
    ("TCP-IP", "tcp ip"),
    ("Théâtre", "théâtre"),
]


class TextMatchingTest(unittest.TestCase):
    def test_normalize_text(self):
        for raw, expected in NORMALIZE_CASES:
            self.assertEqual(normalize_text(raw), expected, raw)

    def test_written_answer_eligibility(self):
        ok = {"choices": {"A": "Paris", "B": "Rome"}, "answer": ["A"]}
        self.assertEqual(written_answer(ok), "Paris")
        multi = {"choices": {"A": "x", "B": "y"}, "answer": ["A", "B"]}
        self.assertIsNone(written_answer(multi))
        vague = {"choices": {"A": "All of the above", "B": "x"}, "answer": ["A"]}
        self.assertIsNone(written_answer(vague))
        long = {"choices": {"A": "word " * 30, "B": "x"}, "answer": ["A"]}
        self.assertIsNone(written_answer(long))
        ambiguous = {"choices": {"A": "The Paris", "B": "paris!"}, "answer": ["A"]}
        self.assertIsNone(written_answer(ambiguous))

    def test_stage_progression(self):
        self.assertEqual(next_progress(True, 0), ("familiar", 1))
        self.assertEqual(next_progress(True, 1), ("familiar", 2))
        self.assertEqual(next_progress(True, 2), ("mastered", 3))
        self.assertEqual(next_progress(False, 2), ("learning", 0))


QUESTIONS = [
    {"text": "Capital of France?", "choices": {"A": "Paris", "B": "Rome", "C": "Madrid"}, "answer": ["A"],
     "answerDescriptions": {"A": "Paris is the capital."}},
    {"text": "Even numbers", "choices": {"A": "2", "B": "3", "C": "4"}, "answer": ["A", "C"], "maxSelections": 2},
]


@unittest.skipIf(DB_ERROR is not None, f"database not reachable: {DB_ERROR}")
class LearnApiTest(unittest.TestCase):
    def setUp(self):
        self.names = []
        self.alice, self.bob = self.user(), self.user()
        s = self.alice.post("/api/sets", json={"title": "L", "questions": QUESTIONS}).get_json()["set"]
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

    def answer(self, qid, client=None, **body):
        return (client or self.alice).post(f"/api/learn/{self.set_id}/{qid}/answer", json=body)

    def progress(self, qid):
        rows = self.alice.get(f"/api/progress/{self.set_id}").get_json()["progress"]
        return next(r["learn"] for r in rows if r["questionId"] == qid)

    def test_three_correct_in_a_row_masters_and_a_miss_resets(self):
        stages = [self.answer(self.q1, format="choice", selected=["A"]).get_json()["stage"] for _ in range(2)]
        self.assertEqual(stages, ["familiar", "familiar"])
        miss = self.answer(self.q1, format="choice", selected=["B"]).get_json()
        self.assertEqual((miss["correct"], miss["stage"], miss["streak"]), (False, "learning", 0))
        for _ in range(3):
            last = self.answer(self.q1, format="choice", selected=["A"]).get_json()
        self.assertEqual((last["stage"], last["streak"]), ("mastered", 3))
        p = self.progress(self.q1)
        self.assertEqual((p["stage"], p["correct"], p["incorrect"]), ("mastered", 5, 1))

    def test_multi_answer_needs_every_choice(self):
        self.assertFalse(self.answer(self.q2, format="choice", selected=["A"]).get_json()["correct"])
        self.assertTrue(self.answer(self.q2, format="choice", selected=["C", "A"]).get_json()["correct"])

    def test_written_answers_ignore_case_and_punctuation(self):
        res = self.answer(self.q1, format="written", text="  the PARIS!! ").get_json()
        self.assertTrue(res["correct"])
        self.assertEqual(res["acceptedText"], "Paris")
        self.assertFalse(self.answer(self.q1, format="written", text="Rome").get_json()["correct"])
        self.assertFalse(self.answer(self.q1, format="written", text="   ").get_json()["correct"])

    def test_written_is_refused_for_multi_answer_questions(self):
        self.assertEqual(self.answer(self.q2, format="written", text="2").status_code, 400)

    def test_recall_self_rating(self):
        self.assertTrue(self.answer(self.q1, format="recall", rating="correct").get_json()["correct"])
        self.assertFalse(self.answer(self.q1, format="recall", rating="incorrect").get_json()["correct"])
        self.assertEqual(self.answer(self.q1, format="recall", rating="maybe").status_code, 400)

    def test_learn_mistakes_reach_mistake_review(self):
        self.answer(self.q1, format="choice", selected=["C"])
        items = self.alice.get("/api/mistakes").get_json()["items"]
        self.assertEqual([(i["questionId"], i["lastWrongMode"]) for i in items], [(self.q1, "learn")])

    def test_resent_answer_is_not_counted_twice(self):
        body = {"format": "choice", "selected": ["A"], "clientAttemptId": "learn_same_123"}
        self.answer(self.q1, **body)
        again = self.answer(self.q1, **body).get_json()
        self.assertTrue(again["duplicate"])
        self.assertEqual(self.progress(self.q1)["correct"], 1)

    def test_validation_and_ownership(self):
        self.assertEqual(self.answer(self.q1, format="essay").status_code, 400)
        self.assertEqual(self.answer(self.q1, format="choice", selected=["Z"]).status_code, 400)
        self.assertEqual(self.answer("q_notinset", format="choice", selected=["A"]).status_code, 400)
        self.assertEqual(self.answer(self.q1, client=self.bob, format="choice", selected=["A"]).status_code, 404)


if __name__ == "__main__":
    unittest.main()
