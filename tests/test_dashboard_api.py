"""Unified dashboard API: every figure is a count of stored records, and each
mode's measure stays separate."""

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
    {"text": f"Question {i}?", "choices": {"A": "yes", "B": "no"}, "answer": ["A"]} for i in range(1, 5)
]


@unittest.skipIf(DB_ERROR is not None, f"database not reachable: {DB_ERROR}")
class DashboardApiTest(unittest.TestCase):
    def setUp(self):
        self.names = []
        self.alice, self.bob = self.user(), self.user()
        s = self.alice.post("/api/sets", json={"title": "Main", "questions": QUESTIONS}).get_json()["set"]
        self.set_id = s["id"]
        self.q = [q["id"] for q in s["questions"]]
        self.other = self.alice.post("/api/sets", json={"title": "Untouched", "questions": QUESTIONS[:2]}).get_json()["set"]["id"]

    def tearDown(self):
        for n in self.names:
            db.execute("DELETE FROM users WHERE username = %s", (n,))

    def user(self):
        name = "apitest_" + secrets.token_hex(4)
        self.names.append(name)
        c = server.app.test_client()
        c.post("/api/auth/register", json={"username": name, "password": secrets.token_hex(8)})
        return c

    def log(self, *attempts):
        res = self.alice.post(f"/api/progress/{self.set_id}/attempts", json={"attempts": [
            {"questionId": qid, "mode": mode, "outcome": outcome, **({"response": resp} if resp else {})}
            for qid, mode, outcome, resp in attempts]})
        self.assertEqual(res.status_code, 200, res.get_json())

    def dash(self, client=None):
        res = (client or self.alice).get(f"/api/dashboard?tzOffset={MANILA}")
        self.assertEqual(res.status_code, 200, res.get_json())
        return res.get_json()

    def main_set(self, d):
        return next(s for s in d["sets"] if s["setId"] == self.set_id)

    def test_empty_account_has_zeroes_not_made_up_numbers(self):
        d = self.dash(self.bob)
        self.assertEqual(d["totals"], {"sets": 0, "questions": 0, "studied": 0, "graded": 0, "accuracy": None,
                                       "mastered": 0, "needsAttention": 0, "reviewDue": 0})
        self.assertEqual(d["continue"], [])
        self.assertEqual(len(d["activity"]), 14)
        self.assertTrue(all(day["answers"] == 0 for day in d["activity"]))
        self.assertEqual(d["practice"], {"recent": [], "count": 0})

    def test_graded_accuracy_leaves_out_self_ratings_reveals_and_skips(self):
        self.log(
            (self.q[0], "practice", "correct", None),
            (self.q[1], "practice", "incorrect", None),
            (self.q[2], "recall", "correct", {"rating": "correct", "selfAssessed": True}),
            (self.q[2], "learn", "correct", {"format": "recall"}),
            (self.q[3], "flashcards", "revealed", None),
            (self.q[3], "practice", "skipped", None),
        )
        d = self.dash()
        a = self.main_set(d)["answers"]
        self.assertEqual((a["studied"], a["graded"], a["correct"], a["accuracy"]), (4, 2, 1, 50))
        today = d["activity"][-1]
        self.assertEqual((today["date"], today["answers"], today["graded"], today["correct"]), (d["today"], 6, 2, 1))
        self.assertEqual((d["totals"]["studied"], d["totals"]["accuracy"]), (4, 50))

    def test_each_mode_keeps_its_own_measure(self):
        self.alice.put(f"/api/progress/{self.set_id}/flashcards/{self.q[0]}", json={"status": "know"})
        self.log((self.q[1], "practice", "incorrect", None))
        db.execute("UPDATE question_progress SET learn_stage = 'mastered' WHERE set_id = %s AND question_id = %s",
                   (self.set_id, self.q[0]))
        s = self.main_set(self.dash())
        # A flashcard "know" is not mastery, and a mistake is not a flashcard label.
        self.assertEqual(s["flashcards"], {"know": 1, "learning": 0, "unmarked": 3})
        self.assertEqual(s["learn"], {"mastered": 1, "familiar": 0, "learning": 0, "new": 3})
        self.assertEqual(s["mistakes"], {"open": 1, "resolved": 0})
        # Studied questions join Smart review, due straight away (same rule as that page).
        self.assertEqual(s["review"]["due"], 1)

    def test_figures_match_the_mistake_and_review_pages(self):
        self.log((self.q[0], "practice", "incorrect", None), (self.q[1], "code", "incorrect", None),
                 (self.q[2], "learn", "correct", None))
        d = self.dash()
        mistakes = self.alice.get("/api/mistakes").get_json()
        review = self.alice.get(f"/api/review/overview?tzOffset={MANILA}").get_json()
        self.assertEqual(d["totals"]["needsAttention"], mistakes["summary"]["open"])
        self.assertEqual(d["totals"]["needsAttention"], 2)
        self.assertEqual(d["totals"]["reviewDue"], review["counts"]["due"])

    def test_sets_are_ordered_by_last_study_and_continue_lists_recent_modes(self):
        self.log((self.q[0], "learn", "correct", None))
        self.log((self.q[1], "code", "correct", None))
        d = self.dash()
        self.assertEqual([s["setId"] for s in d["sets"]], [self.set_id, self.other])
        self.assertIsNone(d["sets"][1]["lastStudiedAt"])
        modes = [c["mode"] for c in d["continue"]]
        self.assertEqual(set(modes), {"learn", "code"})
        self.assertTrue(all(c["setTitle"] == "Main" for c in d["continue"]))
        # Exam and training resume from the dashboard's own button, not here.
        self.log((self.q[2], "exam", "correct", None))
        self.assertNotIn("exam", [c["mode"] for c in self.dash()["continue"]])

    def test_practice_history_oldest_first(self):
        for score in (40, 80):
            self.alice.post("/api/history", json={
                "mode": "Practice", "setId": self.set_id, "score": score, "correct": score // 20, "total": 5,
                "config": {"count": 5, "passPercent": 70, "timerMinutes": None},
                "durationSeconds": 60, "clientAttemptId": "p_" + secrets.token_hex(8)})
        p = self.dash()["practice"]
        self.assertEqual(p["count"], 2)
        self.assertEqual([r["score"] for r in p["recent"]], [40, 80])
        self.assertEqual([r["passPercent"] for r in p["recent"]], [70, 70])

    def test_removed_questions_are_not_counted_and_users_are_separate(self):
        self.log((self.q[0], "practice", "correct", None))
        kept = self.alice.get(f"/api/sets/{self.set_id}").get_json()["set"]["questions"][1:]
        self.alice.post("/api/sets", json={"id": self.set_id, "title": "Main", "questions": kept})
        s = self.main_set(self.dash())
        self.assertEqual((s["questions"], s["answers"]["studied"]), (3, 0))
        self.assertEqual(self.dash(self.bob)["totals"]["sets"], 0)

    def test_bad_timezone(self):
        self.assertEqual(self.alice.get("/api/dashboard?tzOffset=9999").status_code, 400)
        self.assertEqual(server.app.test_client().get("/api/dashboard").status_code, 401)


if __name__ == "__main__":
    unittest.main()
