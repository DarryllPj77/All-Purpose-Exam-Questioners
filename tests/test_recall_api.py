"""Active Recall: accepted-answer matching (no database) and the rating API."""

import secrets
import unittest

from recall_routes import accepted_answers, matches_accepted

try:
    import server
    import db
    db.fetch_one("SELECT 1 AS ok")
    DB_ERROR = None
except Exception as exc:  # pragma: no cover
    DB_ERROR = exc

SINGLE = {"choices": {"A": "Paris", "B": "Rome"}, "answer": ["A"], "acceptedAnswers": ["City of Light"]}
VAGUE = {"choices": {"A": "All of the above", "B": "x"}, "answer": ["A"]}
MULTI = {"choices": {"A": "2", "B": "3", "C": "4"}, "answer": ["A", "C"], "acceptedAnswers": ["2 and 4"]}
MULTI_PLAIN = {"choices": {"A": "2", "B": "3", "C": "4"}, "answer": ["A", "C"]}

# Shared with tests/js/learning.test.js: (question, typed, expected match).
MATCH_CASES = [
    (SINGLE, "paris", True),
    (SINGLE, "  The PARIS. ", True),
    (SINGLE, "city of light!", True),
    (SINGLE, "Rome", False),
    (SINGLE, "", None),
    (VAGUE, "all of the above", None),
    (MULTI, "2 AND 4", True),
    (MULTI, "2", False),
    (MULTI_PLAIN, "2 and 4", None),
]


class MatchingTest(unittest.TestCase):
    def test_accepted_answers(self):
        self.assertEqual(accepted_answers(SINGLE), ["Paris", "City of Light"])
        self.assertEqual(accepted_answers(VAGUE), [])
        self.assertEqual(accepted_answers(MULTI), ["2 and 4"])
        self.assertEqual(accepted_answers(MULTI_PLAIN), [])

    def test_match_cases(self):
        for question, typed, expected in MATCH_CASES:
            self.assertEqual(matches_accepted(question, typed), expected, (typed, question["answer"]))


QUESTIONS = [
    {"text": "Capital of France?", "choices": {"A": "Paris", "B": "Rome"}, "answer": ["A"],
     "acceptedAnswers": ["City of Light"]},
    {"text": "Even numbers", "choices": {"A": "2", "B": "3", "C": "4"}, "answer": ["A", "C"], "maxSelections": 2},
]


@unittest.skipIf(DB_ERROR is not None, f"database not reachable: {DB_ERROR}")
class RecallApiTest(unittest.TestCase):
    def setUp(self):
        self.names = []
        self.alice, self.bob = self.user(), self.user()
        s = self.alice.post("/api/sets", json={"title": "R", "questions": QUESTIONS}).get_json()["set"]
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

    def rate(self, qid, client=None, **body):
        return (client or self.alice).post(f"/api/recall/{self.set_id}/{qid}/rate", json=body)

    def recall(self, qid):
        rows = self.alice.get(f"/api/progress/{self.set_id}").get_json()["progress"]
        return next(r["recall"] for r in rows if r["questionId"] == qid)

    def test_rating_is_saved_and_the_match_is_recorded(self):
        res = self.rate(self.q1, rating="correct", text="the city of light").get_json()
        self.assertEqual((res["rating"], res["autoMatched"]), ("correct", True))
        self.assertEqual(self.recall(self.q1)["rating"], "correct")
        self.rate(self.q1, rating="partial", text="Pari")
        self.assertEqual(self.recall(self.q1)["rating"], "partial")
        logged = self.alice.get(f"/api/progress/{self.set_id}/attempts?mode=recall").get_json()["attempts"]
        self.assertEqual([a["outcome"] for a in logged], ["partial", "correct"])
        self.assertEqual(logged[0]["response"]["autoMatched"], False)
        self.assertTrue(logged[0]["response"]["selfAssessed"])

    def test_self_assessment_wins_over_the_match(self):
        res = self.rate(self.q1, rating="incorrect", text="Paris").get_json()
        self.assertEqual((res["rating"], res["autoMatched"]), ("incorrect", True))

    def test_no_text_or_no_reference_means_no_match(self):
        self.assertIsNone(self.rate(self.q1, rating="correct").get_json()["autoMatched"])
        self.assertIsNone(self.rate(self.q2, rating="correct", text="2 and 4").get_json()["autoMatched"])

    def test_incorrect_reaches_mistake_review_but_partial_does_not(self):
        self.rate(self.q1, rating="partial")
        self.assertEqual(self.alice.get("/api/mistakes").get_json()["items"], [])
        self.rate(self.q1, rating="incorrect")
        items = self.alice.get("/api/mistakes").get_json()["items"]
        self.assertEqual([(i["questionId"], i["lastWrongMode"]) for i in items], [(self.q1, "recall")])

    def test_resent_rating_is_not_counted_twice(self):
        body = {"rating": "correct", "clientAttemptId": "recall_same_1"}
        self.rate(self.q1, **body)
        self.assertTrue(self.rate(self.q1, **body).get_json()["duplicate"])
        logged = self.alice.get(f"/api/progress/{self.set_id}/attempts?mode=recall").get_json()["attempts"]
        self.assertEqual(len(logged), 1)

    def test_validation_and_ownership(self):
        self.assertEqual(self.rate(self.q1, rating="great").status_code, 400)
        self.assertEqual(self.rate(self.q1, rating="correct", text=5).status_code, 400)
        self.assertEqual(self.rate("q_notinset", rating="correct").status_code, 400)
        self.assertEqual(self.rate(self.q1, client=self.bob, rating="correct").status_code, 404)

    def test_accepted_answers_survive_saving(self):
        q = self.alice.get(f"/api/sets/{self.set_id}").get_json()["set"]["questions"][0]
        self.assertEqual(q["acceptedAnswers"], ["City of Light"])


if __name__ == "__main__":
    unittest.main()
