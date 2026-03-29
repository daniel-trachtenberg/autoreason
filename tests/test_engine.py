from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from autoreason.engine import AutoreasonEngine
from autoreason.llm import extract_json_object
from autoreason.models import RunConfig


class FakeClient:
    def __init__(self) -> None:
        self.counts: dict[str, int] = {}

    def complete_json(self, system_prompt: str, user_prompt: str, *, purpose: str, temperature: float):
        self.counts[purpose] = self.counts.get(purpose, 0) + 1
        attempt = self.counts[purpose]

        if purpose == "bootstrap":
            return (
                {
                    "issue": "Should the city impose congestion pricing?",
                    "context_summary": "The city plans congestion pricing after reporting rising traffic and transit funding gaps.",
                    "pro_seed": {
                        "headline": "Pricing can reduce congestion",
                        "argument": "Charging drivers entering the core can reduce unnecessary car trips and fund transit.",
                        "claims": ["Traffic is rising", "Transit needs funding"],
                        "concessions": ["Poor design could burden workers"],
                        "open_questions": ["How should exemptions work?"],
                        "next_targets": ["Show why pricing beats alternatives"],
                    },
                    "con_seed": {
                        "headline": "Pricing can be regressive",
                        "argument": "Congestion pricing may push costs onto workers with the fewest alternatives.",
                        "claims": ["Drivers are not equally flexible", "Fees can be regressive"],
                        "concessions": ["Congestion itself has costs"],
                        "open_questions": ["How elastic is commute demand?"],
                        "next_targets": ["Show strongest equity objections"],
                    },
                },
                {"total_tokens": 100},
            )

        if purpose.startswith("critique:"):
            side = purpose.split(":", 1)[1]
            return (
                {
                    "score": 60 + attempt,
                    "attacks": [f"attack {attempt} on {side}"],
                    "missing_support": [f"missing support {attempt} on {side}"],
                    "blind_spots": [f"blind spot {attempt} on {side}"],
                    "revision_goals": [f"goal {attempt} for {side}"],
                },
                {"total_tokens": 50},
            )

        if purpose.startswith("revise:"):
            side = purpose.split(":", 1)[1]
            return (
                {
                    "headline": f"{side} revised {attempt}",
                    "argument": f"{side} argument revision {attempt}",
                    "claims": [f"{side} claim {attempt}"],
                    "concessions": [f"{side} concession {attempt}"],
                    "open_questions": [f"{side} open question {attempt}"],
                    "next_targets": [f"{side} next target {attempt}"],
                },
                {"total_tokens": 75},
            )

        if purpose == "judge":
            return (
                {
                    "status_summary": "Both sides are sharper after the latest round.",
                    "pro_strengths": ["The pro side now addresses incentives."],
                    "con_strengths": ["The con side now presses equity tradeoffs."],
                    "fault_lines": ["The evidence on exemptions remains weak."],
                    "next_moves": ["Interrogate the funding assumptions."],
                },
                {"total_tokens": 40},
            )

        raise AssertionError(f"Unexpected purpose: {purpose}")


class EngineTests(unittest.TestCase):
    def test_extract_json_object_handles_fenced_payload(self) -> None:
        text = '```json\n{"answer": "ok"}\n```'
        self.assertEqual(extract_json_object(text), {"answer": "ok"})

    def test_bootstrap_and_round_write_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp) / "run"
            engine = AutoreasonEngine(
                client=FakeClient(),
                run_dir=run_dir,
                program_text="Test program",
                config=RunConfig(recursive_depth=2, max_rounds=1, judge_every=1),
            )

            state = engine.bootstrap("News article text", source_label="test-source")
            engine.run(state)

            self.assertEqual(state.round_number, 1)
            self.assertEqual(state.pro.version, 3)
            self.assertEqual(state.con.version, 3)
            self.assertIsNotNone(state.latest_assessment)

            checkpoint = json.loads((run_dir / "checkpoint.json").read_text(encoding="utf-8"))
            self.assertEqual(checkpoint["round_number"], 1)
            self.assertEqual(checkpoint["pro"]["version"], 3)

            events = (run_dir / "events.jsonl").read_text(encoding="utf-8").strip().splitlines()
            self.assertGreaterEqual(len(events), 10)

            latest = (run_dir / "latest.md").read_text(encoding="utf-8")
            self.assertIn("## Pro Argument", latest)
            self.assertIn("## Counterargument", latest)
            self.assertIn("## Latest Assessment", latest)

    def test_load_state_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp) / "run"
            engine = AutoreasonEngine(
                client=FakeClient(),
                run_dir=run_dir,
                program_text="Test program",
                config=RunConfig(),
            )

            state = engine.bootstrap("News article text", source_label="test-source")
            loaded = engine.load_state()

            self.assertEqual(loaded.issue, state.issue)
            self.assertEqual(loaded.pro.headline, state.pro.headline)
            self.assertEqual(loaded.con.argument, state.con.argument)


if __name__ == "__main__":
    unittest.main()
