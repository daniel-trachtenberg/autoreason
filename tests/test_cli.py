from __future__ import annotations

import os
import sys
import unittest
from argparse import Namespace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from autoreason.cli import build_run_config


class CliConfigTests(unittest.TestCase):
    def _base_args(self) -> Namespace:
        return Namespace(
            recursive_depth=None,
            max_rounds=None,
            max_minutes=None,
            judge_every=None,
            pause_seconds=None,
            max_context_chars=None,
            temperature=None,
            program=None,
            llm_mode=None,
            council_model=None,
            council_chairman_model=None,
            council_workers=None,
        )

    def test_council_models_auto_enable_council_mode(self) -> None:
        args = self._base_args()
        args.council_model = ["model-a,model-b"]

        config = build_run_config(args)

        self.assertEqual(config.llm_mode, "council")
        self.assertEqual(config.council_models, ["model-a", "model-b"])

    def test_snapshot_preserves_council_settings_on_resume_defaults(self) -> None:
        args = self._base_args()
        snapshot = {
            "llm_mode": "council",
            "council_models": ["model-a", "model-b", "model-c"],
            "council_chairman_model": "model-c",
            "council_workers": 6,
        }

        config = build_run_config(args, snapshot=snapshot)

        self.assertEqual(config.llm_mode, "council")
        self.assertEqual(config.council_models, ["model-a", "model-b", "model-c"])
        self.assertEqual(config.council_chairman_model, "model-c")
        self.assertEqual(config.council_workers, 6)

    def test_environment_can_supply_council_defaults(self) -> None:
        args = self._base_args()
        previous = {
            "AUTOREASON_COUNCIL_MODELS": os.environ.get("AUTOREASON_COUNCIL_MODELS"),
            "AUTOREASON_LLM_MODE": os.environ.get("AUTOREASON_LLM_MODE"),
            "AUTOREASON_COUNCIL_CHAIRMAN_MODEL": os.environ.get("AUTOREASON_COUNCIL_CHAIRMAN_MODEL"),
            "AUTOREASON_COUNCIL_WORKERS": os.environ.get("AUTOREASON_COUNCIL_WORKERS"),
        }
        try:
            os.environ["AUTOREASON_COUNCIL_MODELS"] = "model-a, model-b"
            os.environ["AUTOREASON_LLM_MODE"] = "council"
            os.environ["AUTOREASON_COUNCIL_CHAIRMAN_MODEL"] = "model-b"
            os.environ["AUTOREASON_COUNCIL_WORKERS"] = "3"

            config = build_run_config(args)
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

        self.assertEqual(config.llm_mode, "council")
        self.assertEqual(config.council_models, ["model-a", "model-b"])
        self.assertEqual(config.council_chairman_model, "model-b")
        self.assertEqual(config.council_workers, 3)


if __name__ == "__main__":
    unittest.main()
