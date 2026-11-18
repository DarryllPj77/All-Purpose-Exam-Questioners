"""Smart Review: scheduling math (no database) and the API (local database)."""

import secrets
import unittest
from datetime import date, datetime, timedelta, timezone

from review_routes import due_at_for, local_midnight_utc, local_today, maturity, next_schedule

try:
    import server
    import db
    db.fetch_one("SELECT 1 AS ok")
    DB_ERROR = None
except Exception as exc:  # pragma: no cover
    DB_ERROR = exc

MANILA = -480     # Date.getTimezoneOffset() for UTC+8
NEW_YORK = 300    # for UTC-5


def utc(*a):
    return datetime(*a, tzinfo=timezone.utc)


class ScheduleMathTest(unittest.TestCase):
    def test_correct_answers_walk_the_intervals_then_grow_to_the_cap(self):
        step, interval, seen = 0, None, []
        for _ in range(9):
            step, interval = next_schedule("correct", step, interval)
            seen.append(interval)
        self.assertEqual(seen, [1, 3, 7, 14, 30, 60, 120, 180, 180])

    def test_partial_repeats_and_incorrect_resets(self):
        self.assertEqual(next_schedule("partial", 3, 7), (3, 7))
        self.assertEqual(next_schedule("partial", 0, None), (0, 1))
        self.assertEqual(next_schedule("incorrect", 5, 30), (0, 1))

    def test_local_day_follows_the_learners_clock(self):
        # 17:00 UTC on the 18th is already 01:00 on the 19th in Manila.
        self.assertEqual(local_today(utc(2026, 11, 18, 17), MANILA), date(2026, 11, 19))
        # 03:00 UTC on the 19th is still 22:00 on the 18th in New York.
        self.assertEqual(local_today(utc(2026, 11, 19, 3), NEW_YORK), date(2026, 11, 18))

    def test_reviews_fall_due_at_local_midnight(self):
        self.assertEqual(local_midnight_utc(date(2026, 11, 19), MANILA), utc(2026, 11, 18, 16))
        self.assertEqual(local_midnight_utc(date(2026, 11, 19), NEW_YORK), utc(2026, 11, 19, 5))
        # Reviewed at 01:00 Manila on the 19th with a 1-day interval → due 00:00 Manila on the 20th.
        self.assertEqual(due_at_for(utc(2026, 11, 18, 17), MANILA, 1), utc(2026, 11, 19, 16))

    def test_maturity(self):
        self.assertEqual([maturity(i) for i in (None, 1, 6, 7, 20, 21, 180)],
                         ["learning", "learning", "learning", "young", "young", "mature", "mature"])


QUESTIONS = [
    {"text": "2 + 2?", "choices": {"A": "3", "B": "4"}, "answer": ["B"]},
    {"text": "Capital of France?", "choices": {"A": "Paris", "B": "Rome"}, "answer": ["A"]},
]


@unittest.skipIf(DB_ERROR is not None, f"database not reachable: {DB_ERROR}")
class ReviewApiTest(unittest.TestCase):
    def setUp(self):
        self.names = []
        self.alice, self.bob = self.user(), self.user()
        s = self.alice.post("/api/sets", json={"title": "S", "questions": QUESTIONS}).get_json()["set"]
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

    def study(self, qid, outcome="correct", mode="exam"):
        self.alice.post(f"/api/progress/{self.set_id}/attempts",
                        json={"attempts": [{"questionId": qid, "mode": mode, "outcome": outcome}]})

    def overview(self, tz=MANILA):
        return self.alice.get(f"/api/review/overview?tzOffset={tz}").get_json()

    def review(self, qid, tz=MANILA, **body):
        body.setdefault("format", "choice")
        body["tzOffset"] = tz
        return self.alice.post(f"/api/review/{self.set_id}/{qid}/answer", json=body)

    def make_due(self, qid):
        db.execute("UPDATE question_progress SET srs_due_at = NOW() - INTERVAL '1 minute' "
                   "WHERE set_id = %s AND question_id = %s", (self.set_id, qid))

    def test_questions_join_the_schedule_only_once_studied(self):
        ov = self.overview()
        self.assertEqual((ov["counts"]["scheduled"], ov["mastery"]["notStarted"]), (0, 2))
        self.study(self.q1)
        ov = self.overview()
        self.assertEqual(ov["counts"]["due"], 1)
        self.assertEqual([i["questionId"] for i in ov["dueItems"]], [self.q1])
        self.assertEqual(ov["dueItems"][0]["question"]["text"], "2 + 2?")

    def test_a_correct_review_schedules_tomorrow_at_local_midnight(self):
        self.study(self.q1)
        res = self.review(self.q1, selected=["B"]).get_json()
        self.assertEqual((res["outcome"], res["step"], res["intervalDays"]), ("correct", 1, 1))
        today = local_today(datetime.now(timezone.utc), MANILA)
        self.assertEqual(res["dueAt"], local_midnight_utc(today + timedelta(days=1), MANILA).isoformat())
        ov = self.overview()
        self.assertEqual(ov["counts"]["due"], 0)
        self.assertEqual(ov["upcoming"][0]["count"], 1)  # tomorrow
        self.assertEqual((ov["counts"]["reviewedToday"], ov["counts"]["correctToday"]), (1, 1))

    def test_interval_grows_then_a_miss_resets_it(self):
        self.study(self.q1)
        intervals = []
        for _ in range(3):
            intervals.append(self.review(self.q1, selected=["B"]).get_json()["intervalDays"])
            self.make_due(self.q1)
        self.assertEqual(intervals, [1, 3, 7])
        miss = self.review(self.q1, selected=["A"]).get_json()
        self.assertEqual((miss["outcome"], miss["step"], miss["intervalDays"]), ("incorrect", 0, 1))

    def test_partial_recall_repeats_the_interval(self):
        self.study(self.q1)
        self.review(self.q1, selected=["B"]); self.make_due(self.q1)
        self.review(self.q1, selected=["B"]); self.make_due(self.q1)  # now 3 days, step 2
        res = self.review(self.q1, format="recall", rating="partial").get_json()
        self.assertEqual((res["outcome"], res["step"], res["intervalDays"]), ("partial", 2, 3))

    def test_a_miss_elsewhere_pulls_the_review_forward_without_resetting_it(self):
        self.study(self.q1)
        self.review(self.q1, selected=["B"]); self.make_due(self.q1)
        self.review(self.q1, selected=["B"])  # 3 days away
        self.assertEqual(self.overview()["counts"]["due"], 0)
        self.study(self.q1, outcome="incorrect", mode="practice")
        ov = self.overview()
        self.assertEqual(ov["counts"]["due"], 1)
        self.assertEqual((ov["dueItems"][0]["step"], ov["dueItems"][0]["intervalDays"]), (2, 3))

    def test_resent_review_does_not_reschedule_twice(self):
        self.study(self.q1)
        body = {"selected": ["B"], "clientAttemptId": "review_same_1"}
        self.review(self.q1, **body)
        again = self.review(self.q1, **body).get_json()
        self.assertTrue(again["duplicate"])
        self.assertEqual(again["step"], 1)

    def test_reviews_are_logged_and_misses_reach_mistake_review(self):
        self.study(self.q2)
        self.review(self.q2, selected=["B"])
        logged = self.alice.get(f"/api/progress/{self.set_id}/attempts?mode=review").get_json()["attempts"]
        self.assertEqual([a["outcome"] for a in logged], ["incorrect"])
        # A missed review is a mistake like a miss in any other mode.
        items = self.alice.get("/api/mistakes").get_json()["items"]
        self.assertEqual([(i["questionId"], i["lastWrongMode"]) for i in items], [(self.q2, "review")])

    def test_validation_and_ownership(self):
        self.study(self.q1)
        self.assertEqual(self.alice.get("/api/review/overview?tzOffset=9999").status_code, 400)
        self.assertEqual(self.review(self.q1, tz=9999, selected=["B"]).status_code, 400)
        self.assertEqual(self.review(self.q1, format="essay").status_code, 400)
        self.assertEqual(self.review(self.q1, format="recall", rating="great").status_code, 400)
        self.assertEqual(self.bob.post(f"/api/review/{self.set_id}/{self.q1}/answer",
                                       json={"format": "choice", "selected": ["B"]}).status_code, 404)
        self.assertEqual(self.bob.get("/api/review/overview").get_json()["counts"]["scheduled"], 0)


if __name__ == "__main__":
    unittest.main()
