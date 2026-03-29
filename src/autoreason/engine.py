from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from autoreason.llm import LLMClient
from autoreason.models import ArgumentVersion, RoundAssessment, RunConfig, RunState


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _bounded_text(text: str, max_chars: int) -> str:
    stripped = text.strip()
    if len(stripped) <= max_chars:
        return stripped
    return stripped[:max_chars].rstrip() + "\n[... truncated for prompt budget ...]"


def _int_score(value: Any, default: int = 50) -> int:
    try:
        return max(0, min(100, int(value)))
    except (TypeError, ValueError):
        return default


def _string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if value is None:
        return []
    text = str(value).strip()
    return [text] if text else []


class AutoreasonEngine:
    def __init__(self, client: LLMClient, run_dir: Path, program_text: str, config: RunConfig):
        self.client = client
        self.run_dir = Path(run_dir)
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.program_text = program_text.strip()
        self.config = config
        self.checkpoint_path = self.run_dir / "checkpoint.json"
        self.events_path = self.run_dir / "events.jsonl"
        self.report_path = self.run_dir / "latest.md"
        self.news_path = self.run_dir / "news.txt"

    def bootstrap(self, news_text: str, source_label: str, thesis_hint: str | None = None) -> RunState:
        if self.checkpoint_path.exists():
            raise FileExistsError(f"Run directory already has a checkpoint: {self.checkpoint_path}")

        system_prompt = self._system_prompt()
        user_prompt = self._bootstrap_prompt(news_text, source_label, thesis_hint)
        payload, usage = self.client.complete_json(
            system_prompt,
            user_prompt,
            purpose="bootstrap",
            temperature=self.config.temperature,
        )

        pro_seed = payload.get("pro_seed") if isinstance(payload.get("pro_seed"), dict) else {}
        con_seed = payload.get("con_seed") if isinstance(payload.get("con_seed"), dict) else {}
        timestamp = utc_now()
        state = RunState(
            run_id=self.run_dir.name,
            created_at=timestamp,
            updated_at=timestamp,
            source_label=source_label,
            news_text=news_text.strip(),
            issue=str(payload.get("issue") or thesis_hint or "Unspecified issue").strip(),
            context_summary=str(payload.get("context_summary") or "").strip(),
            round_number=0,
            event_count=0,
            pro=ArgumentVersion.from_dict("pro", pro_seed, version=1),
            con=ArgumentVersion.from_dict("con", con_seed, version=1),
            latest_assessment=None,
            config_snapshot=self.config.to_dict(),
        )

        self.news_path.write_text(state.news_text + "\n", encoding="utf-8")
        self.append_event(
            state,
            {
                "kind": "bootstrap",
                "source_label": source_label,
                "issue": state.issue,
                "usage": usage,
            },
        )
        self.write_checkpoint(state)
        self.write_report(state)
        return state

    def load_state(self) -> RunState:
        if not self.checkpoint_path.exists():
            raise FileNotFoundError(f"No checkpoint found at {self.checkpoint_path}")
        data = json.loads(self.checkpoint_path.read_text(encoding="utf-8"))
        return RunState.from_dict(data)

    def run(self, state: RunState) -> RunState:
        started_at = datetime.now(timezone.utc)
        deadline = None
        if self.config.max_minutes is not None:
            deadline = started_at + timedelta(minutes=self.config.max_minutes)

        completed_this_session = 0
        while True:
            if self.config.max_rounds > 0 and completed_this_session >= self.config.max_rounds:
                break
            if deadline is not None and datetime.now(timezone.utc) >= deadline:
                break

            self.run_round(state)
            completed_this_session += 1

            if self.config.pause_seconds:
                time.sleep(self.config.pause_seconds)

        return state

    def run_round(self, state: RunState) -> None:
        round_index = state.round_number + 1
        state.pro = self._improve_side(
            state,
            current=state.pro,
            opponent=state.con,
            side="pro",
            round_index=round_index,
            depth=self.config.recursive_depth,
            branch_depth=1,
        )
        state.con = self._improve_side(
            state,
            current=state.con,
            opponent=state.pro,
            side="con",
            round_index=round_index,
            depth=self.config.recursive_depth,
            branch_depth=1,
        )
        state.round_number = round_index

        if self.config.judge_every > 0 and round_index % self.config.judge_every == 0:
            assessment = self._judge_round(state)
            state.latest_assessment = assessment
            self.append_event(
                state,
                {
                    "kind": "judge",
                    "round": round_index,
                    "status_summary": assessment.status_summary,
                    "fault_lines": assessment.fault_lines,
                },
            )
            self.write_checkpoint(state)
            self.write_report(state)

    def append_event(self, state: RunState, event: dict[str, Any]) -> None:
        state.event_count += 1
        timestamp = utc_now()
        state.updated_at = timestamp
        payload = {
            "index": state.event_count,
            "timestamp": timestamp,
            **event,
        }
        with self.events_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=True) + "\n")

    def write_checkpoint(self, state: RunState) -> None:
        self.checkpoint_path.write_text(
            json.dumps(state.to_dict(), indent=2, ensure_ascii=True) + "\n",
            encoding="utf-8",
        )

    def write_report(self, state: RunState) -> None:
        lines = [
            f"# Autoreason: {state.issue}",
            "",
            f"- Run: `{state.run_id}`",
            f"- Source: `{state.source_label}`",
            f"- Completed rounds: `{state.round_number}`",
            f"- Event count: `{state.event_count}`",
            f"- Updated: `{state.updated_at}`",
            "",
            "## News Summary",
            state.context_summary or "No summary yet.",
            "",
            "## Pro Argument",
            f"### {state.pro.headline}",
            "",
            state.pro.argument or "No pro argument yet.",
            "",
            "Claims:",
            *self._bullet_lines(state.pro.claims),
            "",
            "Concessions:",
            *self._bullet_lines(state.pro.concessions),
            "",
            "Open questions:",
            *self._bullet_lines(state.pro.open_questions),
            "",
            "Next hardening targets:",
            *self._bullet_lines(state.pro.next_targets),
            "",
            "## Counterargument",
            f"### {state.con.headline}",
            "",
            state.con.argument or "No counterargument yet.",
            "",
            "Claims:",
            *self._bullet_lines(state.con.claims),
            "",
            "Concessions:",
            *self._bullet_lines(state.con.concessions),
            "",
            "Open questions:",
            *self._bullet_lines(state.con.open_questions),
            "",
            "Next hardening targets:",
            *self._bullet_lines(state.con.next_targets),
        ]

        if state.latest_assessment:
            lines.extend(
                [
                    "",
                    "## Latest Assessment",
                    state.latest_assessment.status_summary or "No status summary.",
                    "",
                    "Pro strengths:",
                    *self._bullet_lines(state.latest_assessment.pro_strengths),
                    "",
                    "Counter strengths:",
                    *self._bullet_lines(state.latest_assessment.con_strengths),
                    "",
                    "Live fault lines:",
                    *self._bullet_lines(state.latest_assessment.fault_lines),
                    "",
                    "Suggested next moves:",
                    *self._bullet_lines(state.latest_assessment.next_moves),
                ]
            )

        self.report_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")

    def _improve_side(
        self,
        state: RunState,
        *,
        current: ArgumentVersion,
        opponent: ArgumentVersion,
        side: str,
        round_index: int,
        depth: int,
        branch_depth: int,
    ) -> ArgumentVersion:
        critique = self._critique_side(state, current=current, opponent=opponent, side=side, round_index=round_index)
        self.append_event(
            state,
            {
                "kind": "critique",
                "side": side,
                "round": round_index,
                "depth": branch_depth,
                "score": critique["score"],
                "revision_goals": critique["revision_goals"],
            },
        )

        revised = self._revise_side(
            state,
            current=current,
            opponent=opponent,
            side=side,
            round_index=round_index,
            critique=critique,
        )
        if side == "pro":
            state.pro = revised
        else:
            state.con = revised
        self.append_event(
            state,
            {
                "kind": "revision",
                "side": side,
                "round": round_index,
                "depth": branch_depth,
                "headline": revised.headline,
                "version": revised.version,
            },
        )
        self.write_checkpoint(state)
        self.write_report(state)

        if depth <= 1:
            return revised

        return self._improve_side(
            state,
            current=revised,
            opponent=opponent,
            side=side,
            round_index=round_index,
            depth=depth - 1,
            branch_depth=branch_depth + 1,
        )

    def _critique_side(
        self,
        state: RunState,
        *,
        current: ArgumentVersion,
        opponent: ArgumentVersion,
        side: str,
        round_index: int,
    ) -> dict[str, Any]:
        user_prompt = self._critique_prompt(state, current=current, opponent=opponent, side=side, round_index=round_index)
        payload, usage = self.client.complete_json(
            self._system_prompt(),
            user_prompt,
            purpose=f"critique:{side}",
            temperature=self.config.temperature,
        )
        return {
            "score": _int_score(payload.get("score")),
            "attacks": _string_list(payload.get("attacks")),
            "missing_support": _string_list(payload.get("missing_support")),
            "blind_spots": _string_list(payload.get("blind_spots")),
            "revision_goals": _string_list(payload.get("revision_goals")),
            "usage": usage,
        }

    def _revise_side(
        self,
        state: RunState,
        *,
        current: ArgumentVersion,
        opponent: ArgumentVersion,
        side: str,
        round_index: int,
        critique: dict[str, Any],
    ) -> ArgumentVersion:
        user_prompt = self._revision_prompt(
            state,
            current=current,
            opponent=opponent,
            side=side,
            round_index=round_index,
            critique=critique,
        )
        payload, _usage = self.client.complete_json(
            self._system_prompt(),
            user_prompt,
            purpose=f"revise:{side}",
            temperature=self.config.temperature,
        )
        return ArgumentVersion.from_dict(side, payload, version=current.version + 1)

    def _judge_round(self, state: RunState) -> RoundAssessment:
        payload, _usage = self.client.complete_json(
            self._system_prompt(),
            self._judge_prompt(state),
            purpose="judge",
            temperature=self.config.temperature,
        )
        return RoundAssessment.from_dict(payload)

    def _system_prompt(self) -> str:
        return (
            "You are part of Autoreason, a recursive dialectical engine that strengthens both sides of a news-driven "
            "argument.\n"
            "Return valid JSON only.\n"
            "Non-negotiable rules:\n"
            "- Treat the news dossier as the primary evidence base.\n"
            "- Separate direct facts from inference.\n"
            "- Steelman both sides and never caricature the opponent.\n"
            "- Prefer a few strong claims over many weak ones.\n"
            "- Surface uncertainty and missing evidence explicitly.\n"
            "- Do not include markdown fences.\n\n"
            "Human operator program:\n"
            f"{self.program_text}"
        )

    def _bootstrap_prompt(self, news_text: str, source_label: str, thesis_hint: str | None) -> str:
        hint = thesis_hint.strip() if thesis_hint else "None"
        return (
            "Read the news dossier and initialize a serious dialectic.\n\n"
            f"Source label: {source_label}\n"
            f"Thesis hint: {hint}\n\n"
            "News dossier:\n"
            f"{news_text.strip()}\n\n"
            "Return a JSON object with this exact shape:\n"
            "{\n"
            '  "issue": "neutral contestable statement of the issue",\n'
            '  "context_summary": "tight summary of the relevant facts",\n'
            '  "pro_seed": {\n'
            '    "headline": "...",\n'
            '    "argument": "...",\n'
            '    "claims": ["..."],\n'
            '    "concessions": ["..."],\n'
            '    "open_questions": ["..."],\n'
            '    "next_targets": ["..."]\n'
            "  },\n"
            '  "con_seed": {\n'
            '    "headline": "...",\n'
            '    "argument": "...",\n'
            '    "claims": ["..."],\n'
            '    "concessions": ["..."],\n'
            '    "open_questions": ["..."],\n'
            '    "next_targets": ["..."]\n'
            "  }\n"
            "}"
        )

    def _critique_prompt(
        self,
        state: RunState,
        *,
        current: ArgumentVersion,
        opponent: ArgumentVersion,
        side: str,
        round_index: int,
    ) -> str:
        return (
            f"Round: {round_index}\n"
            f"Task: Critique the {side} side so it can be hardened further.\n\n"
            f"Issue:\n{state.issue}\n\n"
            f"Context summary:\n{state.context_summary}\n\n"
            "Original dossier excerpt:\n"
            f"{_bounded_text(state.news_text, self.config.max_context_chars)}\n\n"
            f"Current {side} argument v{current.version}:\n"
            f"Headline: {current.headline}\n"
            f"Argument: {current.argument}\n"
            f"Claims: {json.dumps(current.claims)}\n"
            f"Concessions: {json.dumps(current.concessions)}\n\n"
            f"Opponent {opponent.side} argument v{opponent.version}:\n"
            f"Headline: {opponent.headline}\n"
            f"Argument: {opponent.argument}\n"
            f"Claims: {json.dumps(opponent.claims)}\n\n"
            "Return a JSON object:\n"
            "{\n"
            '  "score": 0,\n'
            '  "attacks": ["strongest attacks against the current side"],\n'
            '  "missing_support": ["where the side needs stronger evidence or logic"],\n'
            '  "blind_spots": ["important omissions or unaddressed complexities"],\n'
            '  "revision_goals": ["what the next revision should fix first"]\n'
            "}"
        )

    def _revision_prompt(
        self,
        state: RunState,
        *,
        current: ArgumentVersion,
        opponent: ArgumentVersion,
        side: str,
        round_index: int,
        critique: dict[str, Any],
    ) -> str:
        return (
            f"Round: {round_index}\n"
            f"Task: Revise and harden the {side} side.\n\n"
            f"Issue:\n{state.issue}\n\n"
            f"Context summary:\n{state.context_summary}\n\n"
            "Original dossier excerpt:\n"
            f"{_bounded_text(state.news_text, self.config.max_context_chars)}\n\n"
            f"Current {side} argument v{current.version}:\n"
            f"Headline: {current.headline}\n"
            f"Argument: {current.argument}\n"
            f"Claims: {json.dumps(current.claims)}\n"
            f"Concessions: {json.dumps(current.concessions)}\n"
            f"Open questions: {json.dumps(current.open_questions)}\n\n"
            f"Opponent {opponent.side} argument v{opponent.version}:\n"
            f"Headline: {opponent.headline}\n"
            f"Argument: {opponent.argument}\n"
            f"Claims: {json.dumps(opponent.claims)}\n"
            f"Concessions: {json.dumps(opponent.concessions)}\n\n"
            "Critique to address:\n"
            f"{json.dumps(critique, ensure_ascii=True)}\n\n"
            "Return a JSON object:\n"
            "{\n"
            '  "headline": "short sharper label",\n'
            '  "argument": "improved fully written argument",\n'
            '  "claims": ["best supporting claims"],\n'
            '  "concessions": ["concessions that make this side more credible"],\n'
            '  "open_questions": ["remaining uncertainties"],\n'
            '  "next_targets": ["what to harden next if this side is revised again"]\n'
            "}"
        )

    def _judge_prompt(self, state: RunState) -> str:
        return (
            f"Assess the latest state after round {state.round_number}.\n\n"
            f"Issue:\n{state.issue}\n\n"
            f"Context summary:\n{state.context_summary}\n\n"
            f"Pro argument v{state.pro.version}:\n"
            f"Headline: {state.pro.headline}\n"
            f"Argument: {state.pro.argument}\n"
            f"Claims: {json.dumps(state.pro.claims)}\n"
            f"Concessions: {json.dumps(state.pro.concessions)}\n\n"
            f"Counterargument v{state.con.version}:\n"
            f"Headline: {state.con.headline}\n"
            f"Argument: {state.con.argument}\n"
            f"Claims: {json.dumps(state.con.claims)}\n"
            f"Concessions: {json.dumps(state.con.concessions)}\n\n"
            "Return a JSON object:\n"
            "{\n"
            '  "status_summary": "where the dialectic stands now",\n'
            '  "pro_strengths": ["what currently makes the pro side strong"],\n'
            '  "con_strengths": ["what currently makes the counter side strong"],\n'
            '  "fault_lines": ["big unresolved disagreements or evidentiary gaps"],\n'
            '  "next_moves": ["the next best places to spend another round"]\n'
            "}"
        )

    @staticmethod
    def _bullet_lines(items: list[str]) -> list[str]:
        return [f"- {item}" for item in items] or ["- None recorded."]
