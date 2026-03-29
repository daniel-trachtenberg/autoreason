from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import Request, urlopen

from autoreason.config import load_api_config_from_env
from autoreason.engine import AutoreasonEngine
from autoreason.llm import OpenAICompatibleClient
from autoreason.models import RunConfig


DEFAULT_PROGRAM = """# Autoreason Program

Goal: strengthen both sides of a news-driven argument without strawmen.
"""


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


def build_run_config(args: argparse.Namespace) -> RunConfig:
    return RunConfig(
        recursive_depth=max(1, args.recursive_depth),
        max_rounds=max(0, args.max_rounds),
        max_minutes=args.max_minutes,
        judge_every=max(1, args.judge_every),
        pause_seconds=max(0.0, args.pause_seconds),
        max_context_chars=max(2_000, args.max_context_chars),
        temperature=args.temperature,
        program_path=str(args.program),
    )


def run_command(args: argparse.Namespace) -> int:
    news_text, source_label = load_news_from_args(args)
    run_dir = Path(args.run_dir) if args.run_dir else default_run_dir(Path("runs"), args.thesis_hint or source_label)
    program_text = load_program_text(Path(args.program))
    config = build_run_config(args)
    client = OpenAICompatibleClient(load_api_config_from_env())
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
    program_text = load_program_text(Path(args.program))
    config = build_run_config(args)
    client = OpenAICompatibleClient(load_api_config_from_env())
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
        target.add_argument("--recursive-depth", type=int, default=2)
        target.add_argument("--max-rounds", type=int, default=5)
        target.add_argument("--max-minutes", type=float, default=None)
        target.add_argument("--judge-every", type=int, default=1)
        target.add_argument("--pause-seconds", type=float, default=0.0)
        target.add_argument("--max-context-chars", type=int, default=12_000)
        target.add_argument("--temperature", type=float, default=0.3)
        target.add_argument("--program", type=Path, default=Path("program.md"))

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
