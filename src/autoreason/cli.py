from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import Request, urlopen

from autoreason.config import load_api_config_from_env
from autoreason.engine import AutoreasonEngine
from autoreason.llm import CouncilClient, CouncilMember, OpenAICompatibleClient
from autoreason.models import RunConfig


DEFAULT_PROGRAM = """# Autoreason Program

Goal: strengthen both sides of a news-driven argument without strawmen.
"""
DEFAULT_RUN_CONFIG = RunConfig()


class _HTMLTextExtractor(HTMLParser):
    BLOCK_TAGS = {
        "article",
        "br",
        "div",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "p",
        "section",
        "title",
    }

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript"}:
            self.skip_depth += 1
            return
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript"} and self.skip_depth:
            self.skip_depth -= 1
            return
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self.skip_depth:
            return
        text = data.strip()
        if text:
            self.parts.append(text)

    def text(self) -> str:
        joined = " ".join(self.parts)
        cleaned = re.sub(r"[ \t]+", " ", joined)
        cleaned = re.sub(r"\n\s*\n+", "\n\n", cleaned)
        return cleaned.strip()


def load_program_text(path: Path) -> str:
    if path.exists():
        return path.read_text(encoding="utf-8")
    return DEFAULT_PROGRAM


def load_run_snapshot(run_dir: Path) -> dict[str, object]:
    checkpoint_path = run_dir / "checkpoint.json"
    if not checkpoint_path.exists():
        return {}
    payload = json.loads(checkpoint_path.read_text(encoding="utf-8"))
    snapshot = payload.get("config_snapshot")
    return snapshot if isinstance(snapshot, dict) else {}


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text.lower()).strip("-")
    return slug[:40] or "run"


def default_run_dir(base_dir: Path, seed: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return base_dir / f"{stamp}-{slugify(seed)}"


def fetch_url_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": "autoreason/0.1"})
    with urlopen(request, timeout=30) as response:
        raw = response.read()
        content_type = response.headers.get("Content-Type", "")
    encoding = "utf-8"
    if "charset=" in content_type:
        encoding = content_type.split("charset=", 1)[1].split(";", 1)[0].strip() or "utf-8"
    text = raw.decode(encoding, errors="replace")
    if "<html" not in text.lower():
        return text.strip()
    extractor = _HTMLTextExtractor()
    extractor.feed(text)
    extracted = extractor.text()
    if not extracted:
        raise ValueError(f"Could not extract readable text from {url}")
    return extracted


def load_news_from_args(args: argparse.Namespace) -> tuple[str, str]:
    if getattr(args, "news_text", None):
        return args.news_text.strip(), "inline-text"
    if getattr(args, "news_file", None):
        path = Path(args.news_file)
        return path.read_text(encoding="utf-8").strip(), str(path)
    if getattr(args, "url", None):
        return fetch_url_text(args.url), args.url

    if sys.stdin.isatty():
        raise ValueError("Provide --news-file, --news-text, --url, or pipe article text into stdin.")

    piped = sys.stdin.read().strip()
    if not piped:
        raise ValueError("Stdin was provided but empty.")
    return piped, "stdin"


def parse_model_list(value: list[str] | str | None) -> list[str]:
    if value is None:
        return []

    raw_values = value if isinstance(value, list) else [value]
    models: list[str] = []
    seen: set[str] = set()
    for raw in raw_values:
        for item in str(raw).split(","):
            model = item.strip()
            if model and model not in seen:
                models.append(model)
                seen.add(model)
    return models


def _resolve_value(
    cli_value: object,
    *,
    snapshot: dict[str, object] | None,
    key: str,
    default: object,
    env_value: object | None = None,
) -> object:
    if cli_value not in (None, []):
        return cli_value
    if snapshot:
        snapshot_value = snapshot.get(key)
        if snapshot_value not in (None, [], ""):
            return snapshot_value
    if env_value not in (None, [], ""):
        return env_value
    return default


def resolve_program_path(args: argparse.Namespace, snapshot: dict[str, object] | None = None) -> Path:
    resolved = _resolve_value(
        args.program,
        snapshot=snapshot,
        key="program_path",
        default=DEFAULT_RUN_CONFIG.program_path,
    )
    return Path(str(resolved))


def build_run_config(args: argparse.Namespace, snapshot: dict[str, object] | None = None) -> RunConfig:
    env_council_models = parse_model_list(os.environ.get("AUTOREASON_COUNCIL_MODELS"))
    council_models = parse_model_list(
        _resolve_value(
            parse_model_list(args.council_model),
            snapshot=snapshot,
            key="council_models",
            default=DEFAULT_RUN_CONFIG.council_models,
            env_value=env_council_models,
        )
    )
    llm_mode = str(
        _resolve_value(
            args.llm_mode,
            snapshot=snapshot,
            key="llm_mode",
            default=os.environ.get("AUTOREASON_LLM_MODE", DEFAULT_RUN_CONFIG.llm_mode),
        )
    ).strip() or DEFAULT_RUN_CONFIG.llm_mode
    if llm_mode == DEFAULT_RUN_CONFIG.llm_mode and council_models:
        llm_mode = "council"

    return RunConfig(
        recursive_depth=max(
            1,
            int(
                _resolve_value(
                    args.recursive_depth,
                    snapshot=snapshot,
                    key="recursive_depth",
                    default=DEFAULT_RUN_CONFIG.recursive_depth,
                )
            ),
        ),
        max_rounds=max(
            0,
            int(
                _resolve_value(
                    args.max_rounds,
                    snapshot=snapshot,
                    key="max_rounds",
                    default=DEFAULT_RUN_CONFIG.max_rounds,
                )
            ),
        ),
        max_minutes=_resolve_value(
            args.max_minutes,
            snapshot=snapshot,
            key="max_minutes",
            default=DEFAULT_RUN_CONFIG.max_minutes,
        ),
        judge_every=max(
            1,
            int(
                _resolve_value(
                    args.judge_every,
                    snapshot=snapshot,
                    key="judge_every",
                    default=DEFAULT_RUN_CONFIG.judge_every,
                )
            ),
        ),
        pause_seconds=max(
            0.0,
            float(
                _resolve_value(
                    args.pause_seconds,
                    snapshot=snapshot,
                    key="pause_seconds",
                    default=DEFAULT_RUN_CONFIG.pause_seconds,
                )
            ),
        ),
        max_context_chars=max(
            2_000,
            int(
                _resolve_value(
                    args.max_context_chars,
                    snapshot=snapshot,
                    key="max_context_chars",
                    default=DEFAULT_RUN_CONFIG.max_context_chars,
                )
            ),
        ),
        temperature=float(
            _resolve_value(
                args.temperature,
                snapshot=snapshot,
                key="temperature",
                default=DEFAULT_RUN_CONFIG.temperature,
            )
        ),
        program_path=str(resolve_program_path(args, snapshot)),
        llm_mode=llm_mode,
        council_models=council_models,
        council_chairman_model=str(
            _resolve_value(
                args.council_chairman_model,
                snapshot=snapshot,
                key="council_chairman_model",
                default="",
                env_value=os.environ.get("AUTOREASON_COUNCIL_CHAIRMAN_MODEL", ""),
            )
        ).strip(),
        council_workers=max(
            1,
            int(
                _resolve_value(
                    args.council_workers,
                    snapshot=snapshot,
                    key="council_workers",
                    default=int(os.environ.get("AUTOREASON_COUNCIL_WORKERS", DEFAULT_RUN_CONFIG.council_workers)),
                )
            ),
        ),
    )


def build_client(config: RunConfig):
    api_config = load_api_config_from_env()
    if config.llm_mode == "single":
        if not api_config.model:
            raise ValueError("Single-model mode requires AUTOREASON_MODEL.")
        return OpenAICompatibleClient(api_config)

    council_models = parse_model_list(config.council_models)
    if len(council_models) < 2:
        raise ValueError("Council mode requires at least two distinct models. Use --council-model or AUTOREASON_COUNCIL_MODELS.")

    chairman_model = config.council_chairman_model or api_config.model or council_models[0]
    members = [
        CouncilMember(model=model, client=OpenAICompatibleClient(api_config.with_model(model)))
        for model in council_models
    ]
    chairman = CouncilMember(
        model=chairman_model,
        client=OpenAICompatibleClient(api_config.with_model(chairman_model)),
    )
    return CouncilClient(members, chairman, max_workers=config.council_workers)


def run_command(args: argparse.Namespace) -> int:
    news_text, source_label = load_news_from_args(args)
    run_dir = Path(args.run_dir) if args.run_dir else default_run_dir(Path("runs"), args.thesis_hint or source_label)
    config = build_run_config(args)
    program_text = load_program_text(Path(config.program_path))
    client = build_client(config)
    engine = AutoreasonEngine(client, run_dir, program_text, config)

    state = engine.bootstrap(news_text, source_label=source_label, thesis_hint=args.thesis_hint)
    try:
        engine.run(state)
    except KeyboardInterrupt:
        engine.write_checkpoint(state)
        engine.write_report(state)
        print(f"Interrupted. Checkpoint saved to {run_dir}")
        return 130

    print(f"Run complete: {run_dir}")
    print(f"Latest report: {run_dir / 'latest.md'}")
    return 0


def resume_command(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir)
    snapshot = load_run_snapshot(run_dir)
    config = build_run_config(args, snapshot=snapshot)
    program_text = load_program_text(Path(config.program_path))
    client = build_client(config)
    engine = AutoreasonEngine(client, run_dir, program_text, config)
    state = engine.load_state()

    try:
        engine.run(state)
    except KeyboardInterrupt:
        engine.write_checkpoint(state)
        engine.write_report(state)
        print(f"Interrupted. Checkpoint saved to {run_dir}")
        return 130

    print(f"Run complete: {run_dir}")
    print(f"Latest report: {run_dir / 'latest.md'}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Recursive argument hardening for news inputs.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_runtime_flags(target: argparse.ArgumentParser) -> None:
        target.add_argument("--recursive-depth", type=int, default=None, help="Recursive critique/revision depth per side, default 2.")
        target.add_argument("--max-rounds", type=int, default=None, help="Rounds to run in this session, default 5. Use 0 for no round cap.")
        target.add_argument("--max-minutes", type=float, default=None, help="Optional wall-clock budget in minutes.")
        target.add_argument("--judge-every", type=int, default=None, help="Run a synthesis pass every N rounds, default 1.")
        target.add_argument("--pause-seconds", type=float, default=None, help="Optional cooldown between rounds, default 0.")
        target.add_argument("--max-context-chars", type=int, default=None, help="Prompt budget for the news dossier, default 12000.")
        target.add_argument("--temperature", type=float, default=None, help="Model sampling temperature, default 0.3.")
        target.add_argument("--program", type=Path, default=None, help="Operator instructions file, default program.md.")
        target.add_argument(
            "--llm-mode",
            choices=["single", "council"],
            default=None,
            help="Choose a single model or an LLM council, default single.",
        )
        target.add_argument(
            "--council-model",
            action="append",
            default=None,
            help="Council member model. Repeat the flag or provide a comma-separated list.",
        )
        target.add_argument(
            "--council-chairman-model",
            default=None,
            help="Model used for the final council synthesis. Defaults to AUTOREASON_MODEL.",
        )
        target.add_argument(
            "--council-workers",
            type=int,
            default=None,
            help="Maximum parallel council requests, default 4.",
        )

    run_parser = subparsers.add_parser("run", help="Start a new autoreason run.")
    input_group = run_parser.add_mutually_exclusive_group(required=False)
    input_group.add_argument("--news-file")
    input_group.add_argument("--news-text")
    input_group.add_argument("--url")
    run_parser.add_argument("--thesis-hint")
    run_parser.add_argument("--run-dir")
    add_runtime_flags(run_parser)
    run_parser.set_defaults(func=run_command)

    resume_parser = subparsers.add_parser("resume", help="Resume a previous autoreason run.")
    resume_parser.add_argument("run_dir")
    add_runtime_flags(resume_parser)
    resume_parser.set_defaults(func=resume_command)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except Exception as exc:  # pragma: no cover - surfaced to the CLI user
        parser.exit(status=1, message=f"error: {exc}\n")
