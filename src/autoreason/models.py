from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


def _string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        cleaned = []
        for item in value:
            text = str(item).strip()
            if text:
                cleaned.append(text)
        return cleaned
    text = str(value).strip()
    return [text] if text else []


def _int_value(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _float_value(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


@dataclass
class ArgumentVersion:
    side: str
    version: int
    headline: str
    argument: str
    claims: list[str]
    concessions: list[str]
    open_questions: list[str]
    next_targets: list[str]

    @classmethod
    def from_dict(cls, side: str, data: dict[str, Any], version: int | None = None) -> "ArgumentVersion":
        resolved_version = version if version is not None else _int_value(data.get("version"), 1)
        headline = str(data.get("headline") or f"{side.title()} position").strip()
        argument = str(data.get("argument") or "").strip()
        return cls(
            side=side,
            version=resolved_version,
            headline=headline,
            argument=argument,
            claims=_string_list(data.get("claims")),
            concessions=_string_list(data.get("concessions")),
            open_questions=_string_list(data.get("open_questions")),
            next_targets=_string_list(data.get("next_targets")),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class RoundAssessment:
    status_summary: str
    pro_strengths: list[str]
    con_strengths: list[str]
    fault_lines: list[str]
    next_moves: list[str]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RoundAssessment":
        return cls(
            status_summary=str(data.get("status_summary") or "").strip(),
            pro_strengths=_string_list(data.get("pro_strengths")),
            con_strengths=_string_list(data.get("con_strengths")),
            fault_lines=_string_list(data.get("fault_lines")),
            next_moves=_string_list(data.get("next_moves")),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class RunConfig:
    recursive_depth: int = 2
    max_rounds: int = 5
    max_minutes: float | None = None
    judge_every: int = 1
    pause_seconds: float = 0.0
    max_context_chars: int = 12_000
    temperature: float = 0.3
    program_path: str = "program.md"
    llm_mode: str = "single"
    council_models: list[str] = field(default_factory=list)
    council_chairman_model: str = ""
    council_workers: int = 4

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RunConfig":
        return cls(
            recursive_depth=max(1, _int_value(data.get("recursive_depth"), 2)),
            max_rounds=max(0, _int_value(data.get("max_rounds"), 5)),
            max_minutes=(
                None if data.get("max_minutes") in (None, "", "None") else _float_value(data.get("max_minutes"), 0.0)
            ),
            judge_every=max(1, _int_value(data.get("judge_every"), 1)),
            pause_seconds=max(0.0, _float_value(data.get("pause_seconds"), 0.0)),
            max_context_chars=max(2_000, _int_value(data.get("max_context_chars"), 12_000)),
            temperature=_float_value(data.get("temperature"), 0.3),
            program_path=str(data.get("program_path") or "program.md"),
            llm_mode=str(data.get("llm_mode") or "single"),
            council_models=_string_list(data.get("council_models")),
            council_chairman_model=str(data.get("council_chairman_model") or ""),
            council_workers=max(1, _int_value(data.get("council_workers"), 4)),
        )


@dataclass
class RunState:
    run_id: str
    created_at: str
    updated_at: str
    source_label: str
    news_text: str
    issue: str
    context_summary: str
    round_number: int
    event_count: int
    pro: ArgumentVersion
    con: ArgumentVersion
    latest_assessment: RoundAssessment | None
    config_snapshot: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "source_label": self.source_label,
            "news_text": self.news_text,
            "issue": self.issue,
            "context_summary": self.context_summary,
            "round_number": self.round_number,
            "event_count": self.event_count,
            "pro": self.pro.to_dict(),
            "con": self.con.to_dict(),
            "latest_assessment": self.latest_assessment.to_dict() if self.latest_assessment else None,
            "config_snapshot": self.config_snapshot,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RunState":
        assessment = data.get("latest_assessment")
        return cls(
            run_id=str(data.get("run_id") or ""),
            created_at=str(data.get("created_at") or ""),
            updated_at=str(data.get("updated_at") or ""),
            source_label=str(data.get("source_label") or ""),
            news_text=str(data.get("news_text") or ""),
            issue=str(data.get("issue") or ""),
            context_summary=str(data.get("context_summary") or ""),
            round_number=_int_value(data.get("round_number"), 0),
            event_count=_int_value(data.get("event_count"), 0),
            pro=ArgumentVersion.from_dict("pro", data.get("pro") or {}),
            con=ArgumentVersion.from_dict("con", data.get("con") or {}),
            latest_assessment=RoundAssessment.from_dict(assessment) if isinstance(assessment, dict) else None,
            config_snapshot=data.get("config_snapshot") or {},
        )
