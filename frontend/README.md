# autoreason frontend

This folder contains a standalone Next.js frontend for `autoreason`.

## What it does

- launches the existing Python CLI in the parent repo
- stores runs in the same `../runs` folder as the CLI
- polls `checkpoint.json` and `latest.md` to show progress and results

## Run it

```bash
cd frontend
npm run dev
```

The dev script uses webpack instead of Turbopack so it stays stable on machines where Turbopack has CPU-specific issues.

The app expects the same environment variables as the CLI, for example:

```bash
export AUTOREASON_API_KEY=...
export AUTOREASON_MODEL=...
```

For council mode, you can also set:

```bash
export AUTOREASON_COUNCIL_MODELS="openai/gpt-5,anthropic/claude-sonnet-4"
export AUTOREASON_COUNCIL_CHAIRMAN_MODEL="openai/gpt-5"
```
