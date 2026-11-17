"""Sanity checks so a config edit can't silently break the learning rules."""

import json
import unittest

import learning_config as cfg


class LearningConfigTest(unittest.TestCase):
    def test_public_config_is_json(self):
        json.dumps(cfg.public_config())

    def test_existing_modes_are_known(self):
        self.assertIn("exam", cfg.STUDY_MODES)
        self.assertIn("training", cfg.STUDY_MODES)

    def test_mastery_needs_more_than_one_correct_answer(self):
        self.assertGreater(cfg.LEARN_MASTERY["correct_streak_for_mastered"], 1)
        self.assertLessEqual(
            cfg.LEARN_MASTERY["correct_streak_for_familiar"],
            cfg.LEARN_MASTERY["correct_streak_for_mastered"],
        )

    def test_review_intervals_grow(self):
        steps = cfg.SRS["intervals_days"]
        self.assertTrue(steps and steps[0] >= 1)
        self.assertEqual(steps, sorted(steps))
        self.assertLessEqual(steps[-1], cfg.SRS["max_interval_days"])

    def test_mistakes_need_more_than_one_retry(self):
        self.assertGreater(cfg.MISTAKES["correct_retries_to_resolve"], 1)


if __name__ == "__main__":
    unittest.main()
