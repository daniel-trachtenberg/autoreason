# autoreason

`autoreason` turns a news item into a long-running dialectic loop:

1. It reads the news and identifies the core issue.
2. It seeds a serious argument for that issue.
3. It recursively critiques and revises that argument.
4. It then recursively critiques and revises the counterargument.
5. It repeats for as many rounds as you want, checkpointing after every step.

The design is inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch): the code runs the loop, while [`program.md`](./program.md) is the lightweight human-editable control surface that shapes how the system reasons.

## Features

- Recursive hardening for both the argument and the counterargument
- Resumable runs with `checkpoint.json`, `events.jsonl`, and `latest.md`
- Long-running sessions with round limits, time limits, or both
- Generic OpenAI-compatible API client, so you can point it at OpenAI or another compatible backend
- Optional `llm-council`-style multi-model mode with peer ranking and chairman synthesis
- Zero third-party Python dependencies
- Optional URL ingestion for HTML news articles

## Quick Start

Install the package in editable mode:

```bash
python3 -m pip install -e .
```

Set the model connection:

```bash
export AUTOREASON_API_KEY=...
export AUTOREASON_MODEL=...
export AUTOREASON_BASE_URL=https://api.openai.com/v1
```

For council runs, you can route multiple models through one OpenAI-compatible endpoint:

```bash
export AUTOREASON_API_KEY=...
export AUTOREASON_BASE_URL=https://openrouter.ai/api/v1
export AUTOREASON_COUNCIL_MODELS="openai/gpt-5,anthropic/claude-sonnet-4,google/gemini-2.5-pro"
export AUTOREASON_COUNCIL_CHAIRMAN_MODEL="openai/gpt-5"
```

Run on a local text file:

```bash
autoreason run \
  --news-file ./news.txt \
  --recursive-depth 3 \
  --max-rounds 10
```

Run directly from a URL and let it keep going for hours:

```bash
autoreason run \
  --url "https://example.com/news-story" \
  --recursive-depth 3 \
  --max-rounds 0 \
  --max-minutes 240
```

Run in council mode:

```bash
autoreason run \
  --url "https://example.com/news-story" \
  --llm-mode council \
  --council-model openai/gpt-5 \
  --council-model anthropic/claude-sonnet-4 \
  --council-model google/gemini-2.5-pro \
  --council-chairman-model openai/gpt-5 \
  --recursive-depth 2 \
  --max-rounds 3
```

Resume a previous run:

```bash
autoreason resume ./runs/20260328-203000-market-tariffs
```

## CLI

### `autoreason run`

Input options:

- `--news-file PATH`
- `--news-text "..." `
- `--url URL`
- or pipe the article into stdin

Runtime options:

- `--recursive-depth N` recursive critique/revision depth per side, default `2`
- `--max-rounds N` rounds to run this session, default `5`; use `0` for no round cap
- `--max-minutes N` optional wall-clock budget
- `--judge-every N` run a synthesis pass every N rounds, default `1`
- `--pause-seconds N` optional cooldown between rounds
- `--max-context-chars N` prompt budget for the article text, default `12000`
- `--temperature FLOAT` model sampling temperature, default `0.3`
- `--program PATH` operator instructions file, default `program.md`
- `--run-dir PATH` explicit output directory
- `--thesis-hint "..."` optional nudge for how to frame the issue
- `--llm-mode {single,council}` choose single model or council mode
- `--council-model MODEL` repeat or comma-separate council member models
- `--council-chairman-model MODEL` choose the final synthesizer in council mode
- `--council-workers N` parallelism for council requests, default `4`

### `autoreason resume`

Loads `checkpoint.json` from an existing run directory and continues using the current `program.md` and runtime flags.

## Run Output

Every run directory contains:

- `news.txt` original ingested text
- `checkpoint.json` latest machine-readable state
- `events.jsonl` append-only event log
- `latest.md` easy-to-read report with the current strongest version of each side

## Notes

- The API client expects an OpenAI-compatible `POST /chat/completions` endpoint.
- Council mode is inspired by [karpathy/llm-council](https://github.com/karpathy/llm-council): gather independent candidates, rank them anonymously, then synthesize a chairman answer.
- Council mode works best with a router that can access multiple providers through one OpenAI-compatible endpoint, such as OpenRouter.
- The system tries to keep both sides serious and non-caricatured.
- Edit [`program.md`](./program.md) to change the style of reasoning without changing Python code.
