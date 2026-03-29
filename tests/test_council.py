from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from autoreason.llm import CouncilClient, CouncilMember


class ScriptedClient:
    def __init__(self, model_name: str, responses: dict[str, tuple[dict, dict]]) -> None:
        self.model_name = model_name
        self.responses = responses
        self.calls: list[str] = []

    def complete_json(self, system_prompt: str, user_prompt: str, *, purpose: str, temperature: float):
        self.calls.append(purpose)
        if purpose not in self.responses:
            raise AssertionError(f"Unexpected purpose {purpose} for {self.model_name}")
        return self.responses[purpose]


class CouncilClientTests(unittest.TestCase):
    def test_council_collects_ranks_and_synthesizes(self) -> None:
        member_a = ScriptedClient(
            "model-a",
            {
                "demo": ({"answer": "A"}, {"usage": {"total_tokens": 10}}),
                "council-rank:demo": (
                    {
                        "evaluations": [
                            {"candidate": "Candidate A", "strengths": ["clear"], "weaknesses": ["thin"]},
                            {"candidate": "Candidate B", "strengths": ["strong"], "weaknesses": ["verbose"]},
                        ],
                        "ranking": ["Candidate B", "Candidate A"],
                        "reasoning_summary": "B is stronger overall.",
                    },
                    {"usage": {"total_tokens": 6}},
                ),
            },
        )
        member_b = ScriptedClient(
            "model-b",
            {
                "demo": ({"answer": "B"}, {"usage": {"total_tokens": 11}}),
                "council-rank:demo": (
                    {
                        "evaluations": [
                            {"candidate": "Candidate A", "strengths": ["concise"], "weaknesses": ["missing detail"]},
                            {"candidate": "Candidate B", "strengths": ["complete"], "weaknesses": ["none"]},
                        ],
                        "ranking": ["Candidate B", "Candidate A"],
                        "reasoning_summary": "B wins on completeness.",
                    },
                    {"usage": {"total_tokens": 7}},
                ),
            },
        )
        chairman = ScriptedClient(
            "chairman",
            {
                "council-synthesize:demo": (
                    {"answer": "Synthesized B"},
                    {"usage": {"total_tokens": 12}},
                )
            },
        )

        client = CouncilClient(
            [
                CouncilMember(model="model-a", client=member_a),
                CouncilMember(model="model-b", client=member_b),
            ],
            CouncilMember(model="chairman", client=chairman),
            max_workers=2,
        )

        result, metadata = client.complete_json(
            "Return JSON only.",
            "Solve the task.",
            purpose="demo",
            temperature=0.1,
        )

        self.assertEqual(result, {"answer": "Synthesized B"})
        self.assertEqual(metadata["mode"], "council")
        self.assertEqual(metadata["aggregate_rankings"][0]["candidate"], "Candidate B")
        self.assertEqual(metadata["candidate_map"]["Candidate A"], "model-a")
        self.assertIn("demo", member_a.calls)
        self.assertIn("council-rank:demo", member_b.calls)
        self.assertIn("council-synthesize:demo", chairman.calls)

    def test_council_degrades_to_single_valid_member(self) -> None:
        class FailingClient:
            def complete_json(self, system_prompt: str, user_prompt: str, *, purpose: str, temperature: float):
                raise RuntimeError("boom")

        survivor = ScriptedClient(
            "model-a",
            {
                "demo": ({"answer": "A"}, {"usage": {"total_tokens": 10}}),
            },
        )

        client = CouncilClient(
            [
                CouncilMember(model="model-a", client=survivor),
                CouncilMember(model="model-b", client=FailingClient()),
            ],
            CouncilMember(model="chairman", client=survivor),
            max_workers=2,
        )

        result, metadata = client.complete_json(
            "Return JSON only.",
            "Solve the task.",
            purpose="demo",
            temperature=0.1,
        )

        self.assertEqual(result, {"answer": "A"})
        self.assertTrue(metadata["degraded"])
        self.assertIn("model-b", metadata["errors"][0])


if __name__ == "__main__":
    unittest.main()
