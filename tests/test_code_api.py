"""Code Challenge: grading rules (no database) and the API (local database)."""

import secrets
import unittest

from code_routes import challenge_of, expected_output, grade, normalize_output

try:
    import server
    import db
    db.fetch_one("SELECT 1 AS ok")
    DB_ERROR = None
except Exception as exc:  # pragma: no cover
    DB_ERROR = exc

OUTPUT_Q = {
    "text": "What does this print?", "challenge": "output", "language": "csharp",
    "code": 'Console.WriteLine("Ana:3");\nConsole.WriteLine("Ben:3");',
    "choices": {"A": "Ana:3\nBen:3", "B": "Ana:3 Ben:3"}, "answer": ["A"],
}
BUG_Q = {
    "text": "Find the bug.", "challenge": "bug", "code": "for (int i = 0; i <= n; i++) {}",
    "choices": {"A": "<= should be <", "B": "Nothing"}, "answer": ["A"],
}
MULTI_Q = {
    "text": "Which two are value types?", "code": "int a; string b; DateTime c;",
    "choices": {"A": "a", "B": "b", "C": "c"}, "answer": ["A", "C"],
}


class GradingTest(unittest.TestCase):
    def test_output_normalisation_matches_the_js_rule(self):
        self.assertEqual(normalize_output("\r\nAna:3  \r\nBen:3\r\n\r\n"), "Ana:3\nBen:3")
        self.assertNotEqual(normalize_output("ana:3"), normalize_output("Ana:3"))
        self.assertNotEqual(normalize_output("a\n\nb"), normalize_output("a\nb"))

    def test_typed_output(self):
        self.assertEqual(grade(OUTPUT_Q, {"format": "output", "text": "Ana:3   \r\nBen:3\n"})[0], "correct")
        self.assertEqual(grade(OUTPUT_Q, {"format": "output", "text": "ana:3\nben:3"})[0], "incorrect")
        self.assertEqual(grade(OUTPUT_Q, {"format": "output", "text": "   "})[0], "incorrect")

    def test_typed_output_only_for_output_challenges(self):
        self.assertIsNone(expected_output(BUG_Q))
        with self.assertRaises(ValueError):
            grade(BUG_Q, {"format": "output", "text": "x"})

    def test_choices_must_match_exactly(self):
        self.assertEqual(grade(MULTI_Q, {"format": "choice", "selected": ["C", "A"]})[0], "correct")
        self.assertEqual(grade(MULTI_Q, {"format": "choice", "selected": ["A"]})[0], "incorrect")
        self.assertEqual(grade(MULTI_Q, {"format": "choice", "selected": ["A", "B", "C"]})[0], "incorrect")
        with self.assertRaises(ValueError):
            grade(MULTI_Q, {"format": "choice", "selected": ["Z"]})
        with self.assertRaises(ValueError):
            grade(MULTI_Q, {"format": "run", "code": "System.exit()"})

    def test_unknown_challenge_is_plain_choice(self):
        self.assertEqual(challenge_of({"challenge": "nope"}), "choice")
        self.assertEqual(challenge_of(MULTI_Q), "choice")


@unittest.skipIf(DB_ERROR is not None, f"database not reachable: {DB_ERROR}")
class CodeApiTest(unittest.TestCase):
    def setUp(self):
        self.names = []
        self.alice, self.bob = self.user(), self.user()
        s = self.alice.post("/api/sets", json={"title": "Code", "questions": [OUTPUT_Q, BUG_Q, MULTI_Q]}).get_json()["set"]
        self.set_id = s["id"]
        self.q_out, self.q_bug, self.q_multi = (q["id"] for q in s["questions"])

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
        return (client or self.alice).post(f"/api/code/{self.set_id}/{qid}/answer", json=body)

    def test_set_keeps_the_code_fields(self):
        q = self.alice.get(f"/api/sets/{self.set_id}").get_json()["set"]["questions"][0]
        self.assertEqual((q["challenge"], q["language"]), ("output", "csharp"))
        self.assertIn("Console.WriteLine", q["code"])

    def test_graded_answers_are_logged_with_mode_code(self):
        res = self.answer(self.q_out, format="output", text="Ana:3\nBen:3").get_json()
        self.assertEqual((res["outcome"], res["expectedOutput"]), ("correct", "Ana:3\nBen:3"))
        res = self.answer(self.q_multi, format="choice", selected=["A"]).get_json()
        self.assertEqual((res["outcome"], res["correctAnswer"]), ("incorrect", ["A", "C"]))
        logged = self.alice.get(f"/api/progress/{self.set_id}/attempts?mode=code").get_json()["attempts"]
        self.assertEqual(sorted(a["outcome"] for a in logged), ["correct", "incorrect"])

    def test_a_miss_reaches_mistake_review_with_its_code(self):
        self.answer(self.q_bug, format="choice", selected=["B"])
        items = self.alice.get("/api/mistakes").get_json()["items"]
        self.assertEqual([(i["questionId"], i["lastWrongMode"]) for i in items], [(self.q_bug, "code")])
        self.assertEqual(items[0]["question"]["code"], BUG_Q["code"])

    def test_resend_is_not_logged_twice(self):
        body = {"format": "choice", "selected": ["A"], "clientAttemptId": "code_same_1"}
        self.answer(self.q_bug, **body)
        self.assertTrue(self.answer(self.q_bug, **body).get_json()["duplicate"])
        logged = self.alice.get(f"/api/progress/{self.set_id}/attempts?mode=code").get_json()["attempts"]
        self.assertEqual(len(logged), 1)

    def test_validation_and_ownership(self):
        self.assertEqual(self.answer(self.q_bug, format="output", text="x").status_code, 400)
        self.assertEqual(self.answer(self.q_bug, format="choice", selected=[]).status_code, 400)
        self.assertEqual(self.answer(self.q_bug, format="choice", selected=["A"], clientAttemptId="x").status_code, 400)
        self.assertEqual(self.answer(self.q_bug, client=self.bob, format="choice", selected=["A"]).status_code, 404)
        self.assertEqual(self.alice.post(f"/api/code/{self.set_id}/q_0000000000000000/answer",
                                         json={"format": "choice", "selected": ["A"]}).status_code, 400)


if __name__ == "__main__":
    unittest.main()
