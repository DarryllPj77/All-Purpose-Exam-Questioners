"""Unit tests for question_ids (no database needed)."""

import unittest

from question_ids import QUESTION_ID_RE, assign_question_ids, content_hash_id


def q(text, answer=("A",), **extra):
    return {"text": text, "choices": {"A": "one", "B": "two"}, "answer": list(answer), **extra}


class AssignQuestionIdsTest(unittest.TestCase):
    def test_every_question_gets_a_well_formed_id(self):
        out, changed = assign_question_ids([q("first"), q("second")])
        self.assertTrue(changed)
        for item in out:
            self.assertRegex(item["id"], QUESTION_ID_RE)

    def test_same_content_gives_same_id(self):
        self.assertEqual(content_hash_id(q("same")), content_hash_id(q("same")))

    def test_answer_order_does_not_change_id(self):
        self.assertEqual(content_hash_id(q("multi", ("A", "B"))), content_hash_id(q("multi", ("B", "A"))))

    def test_different_content_gives_different_ids(self):
        self.assertNotEqual(content_hash_id(q("one")), content_hash_id(q("two")))
        self.assertNotEqual(content_hash_id(q("x", ("A",))), content_hash_id(q("x", ("B",))))

    def test_existing_valid_ids_are_kept(self):
        out, changed = assign_question_ids([q("edited text", id="q_keepme")])
        self.assertFalse(changed)
        self.assertEqual(out[0]["id"], "q_keepme")

    def test_exact_duplicates_get_suffixes(self):
        out, _ = assign_question_ids([q("dup"), q("dup"), q("dup")])
        ids = [item["id"] for item in out]
        self.assertEqual(len(set(ids)), 3)
        self.assertEqual(ids[1], ids[0] + "-2")
        self.assertEqual(ids[2], ids[0] + "-3")

    def test_duplicate_supplied_ids_are_replaced(self):
        out, changed = assign_question_ids([q("a", id="q_same"), q("b", id="q_same")])
        self.assertTrue(changed)
        self.assertEqual(out[0]["id"], "q_same")
        self.assertNotEqual(out[1]["id"], "q_same")

    def test_malformed_ids_are_replaced(self):
        out, changed = assign_question_ids([q("a", id="has spaces"), q("b", id=42)])
        self.assertTrue(changed)
        for item in out:
            self.assertRegex(item["id"], QUESTION_ID_RE)

    def test_new_question_cannot_take_an_existing_id(self):
        taken = content_hash_id(q("new"))
        out, _ = assign_question_ids([q("new"), q("other", id=taken)])
        self.assertEqual(out[1]["id"], taken)          # the explicit id wins
        self.assertNotEqual(out[0]["id"], taken)       # the new one is moved aside

    def test_input_is_not_mutated(self):
        original = [q("immutable")]
        assign_question_ids(original)
        self.assertNotIn("id", original[0])

    def test_running_twice_is_stable(self):
        once, _ = assign_question_ids([q("a"), q("a"), q("b")])
        twice, changed = assign_question_ids(once)
        self.assertFalse(changed)
        self.assertEqual(once, twice)


if __name__ == "__main__":
    unittest.main()
