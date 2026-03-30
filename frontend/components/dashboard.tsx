"use client";

import { startTransition, useEffect, useEffectEvent, useMemo, useState } from "react";

import type { LaunchRunRequest, LlmMode, RunDetail, RunSummary } from "@/lib/types";

const POLL_INTERVAL_MS = 4000;

type FormState = {
  newsText: string;
  thesisHint: string;
  recursiveDepth: number;
  maxRounds: number;
  maxMinutes: string;
  judgeEvery: number;
  pauseSeconds: number;
  llmMode: LlmMode;
  councilModels: string;
  councilChairmanModel: string;
  councilWorkers: number;
};

const defaultForm: FormState = {
  newsText: "",
  thesisHint: "",
  recursiveDepth: 2,
  maxRounds: 5,
  maxMinutes: "",
  judgeEvery: 1,
  pauseSeconds: 0,
  llmMode: "single",
  councilModels: "openai/gpt-5\nanthropic/claude-sonnet-4\ngoogle/gemini-2.5-pro",
  councilChairmanModel: "openai/gpt-5",
  councilWorkers: 4,
};

async function requestRuns() {
  const response = await fetch("/api/runs", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as { runs: RunSummary[] };
}

async function requestRunDetail(runId: string) {
  const response = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as RunDetail;
}

function parseCouncilModels(value: string) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function statusTone(status: string) {
  if (status === "completed") return "bg-emerald-100 text-emerald-900";
  if (status === "failed") return "bg-rose-100 text-rose-900";
  if (status === "running" || status === "launching") return "bg-amber-100 text-amber-900";
  return "bg-stone-200 text-stone-700";
}

function formatTimestamp(value: string) {
  if (!value) return "Waiting for first checkpoint";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function detailLabel(detail: RunDetail | null) {
  if (!detail) return "No run selected";
  return detail.issue || detail.id;
}

export function Dashboard() {
  const [form, setForm] = useState<FormState>(defaultForm);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [isLaunching, setIsLaunching] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const councilModels = useMemo(() => parseCouncilModels(form.councilModels), [form.councilModels]);
  const commandPreview = useMemo(() => {
    const parts = [
      "PYTHONPATH=src",
      "python3",
      "-m",
      "autoreason",
      "run",
      "--news-file",
      "<saved-news-file>",
      "--recursive-depth",
      String(form.recursiveDepth),
      "--max-rounds",
      String(form.maxRounds),
      "--judge-every",
      String(form.judgeEvery),
      "--pause-seconds",
      String(form.pauseSeconds),
    ];

    if (form.maxMinutes.trim()) {
      parts.push("--max-minutes", form.maxMinutes.trim());
    }
    if (form.thesisHint.trim()) {
      parts.push("--thesis-hint", JSON.stringify(form.thesisHint.trim()));
    }
    if (form.llmMode === "council") {
      parts.push("--llm-mode", "council");
      for (const model of councilModels) {
        parts.push("--council-model", model);
      }
      if (form.councilChairmanModel.trim()) {
        parts.push("--council-chairman-model", form.councilChairmanModel.trim());
      }
      parts.push("--council-workers", String(form.councilWorkers));
    }

    return parts.join(" ");
  }, [councilModels, form]);

  const loadRuns = useEffectEvent(async (preferredRunId?: string | null) => {
    setIsRefreshing(true);
    try {
      const payload = await requestRuns();
      setRuns(payload.runs);

      const nextSelected =
        preferredRunId && payload.runs.some((run) => run.id === preferredRunId)
          ? preferredRunId
          : selectedRunId && payload.runs.some((run) => run.id === selectedRunId)
            ? selectedRunId
            : payload.runs[0]?.id ?? null;

      if (nextSelected !== selectedRunId) {
        startTransition(() => setSelectedRunId(nextSelected));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load runs.";
      setErrorMessage(message);
    } finally {
      setIsRefreshing(false);
    }
  });

  const loadRunDetail = useEffectEvent(async (runId: string | null) => {
    if (!runId) {
      setSelectedRun(null);
      return;
    }

    try {
      setSelectedRun(await requestRunDetail(runId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load run details.";
      setErrorMessage(message);
    }
  });

  useEffect(() => {
    void loadRuns(selectedRunId);
    const interval = window.setInterval(() => {
      void loadRuns(selectedRunId);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [selectedRunId]);

  useEffect(() => {
    void loadRunDetail(selectedRunId);
    if (!selectedRunId) return;
    const interval = window.setInterval(() => {
      void loadRunDetail(selectedRunId);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [selectedRunId]);

  async function handleLaunch() {
    setErrorMessage("");
    if (!form.newsText.trim()) {
      setErrorMessage("Paste a news article or summary before starting a run.");
      return;
    }
    if (form.llmMode === "council" && councilModels.length < 2) {
      setErrorMessage("Council mode needs at least two models.");
      return;
    }

    const payload: LaunchRunRequest = {
      newsText: form.newsText.trim(),
      thesisHint: form.thesisHint.trim() || undefined,
      recursiveDepth: form.recursiveDepth,
      maxRounds: form.maxRounds,
      maxMinutes: form.maxMinutes.trim() ? Number(form.maxMinutes.trim()) : null,
      judgeEvery: form.judgeEvery,
      pauseSeconds: form.pauseSeconds,
      llmMode: form.llmMode,
      councilModels,
      councilChairmanModel: form.councilChairmanModel.trim() || undefined,
      councilWorkers: form.councilWorkers,
    };

    setIsLaunching(true);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }

      const created = (await response.json()) as { runId: string };
      startTransition(() => setSelectedRunId(created.runId));
      const runsPayload = await requestRuns();
      setRuns(runsPayload.runs);
      setSelectedRun(await requestRunDetail(created.runId));
      setForm((current) => ({
        ...current,
        newsText: "",
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start the run.";
      setErrorMessage(message);
    } finally {
      setIsLaunching(false);
    }
  }

  async function copyCommand() {
    try {
      const value = selectedRun?.commandPreview || commandPreview;
      await navigator.clipboard.writeText(value);
      setCopyFeedback("Command copied.");
      window.setTimeout(() => setCopyFeedback(""), 1800);
    } catch {
      setCopyFeedback("Clipboard unavailable.");
      window.setTimeout(() => setCopyFeedback(""), 1800);
    }
  }

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-6 text-[color:var(--foreground)] sm:px-6 lg:px-10">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[-10rem] top-[-6rem] h-72 w-72 rounded-full bg-[rgba(106,164,152,0.22)] blur-3xl animate-[float_16s_ease-in-out_infinite]" />
        <div className="absolute right-[-7rem] top-24 h-80 w-80 rounded-full bg-[rgba(238,190,138,0.20)] blur-3xl animate-[float_19s_ease-in-out_infinite]" />
        <div className="absolute bottom-[-8rem] left-1/3 h-96 w-96 rounded-full bg-[rgba(161,180,204,0.18)] blur-3xl animate-[float_20s_ease-in-out_infinite]" />
      </div>

      <div className="relative mx-auto flex max-w-7xl flex-col gap-6">
        <header className="panel flex flex-col gap-5 p-6 sm:p-8">
          <div className="flex flex-wrap items-center gap-3 text-xs font-semibold uppercase tracking-[0.24em] text-[color:var(--muted)]">
            <span className="rounded-full bg-[var(--accent-soft)] px-3 py-1 text-[color:var(--accent)]">
              CLI + Web UI
            </span>
            <span>Next.js App Router</span>
            <span>Tailwind CSS</span>
          </div>
          <div className="grid gap-5 lg:grid-cols-[1.3fr_0.7fr]">
            <div className="space-y-3">
              <p className="text-sm font-medium uppercase tracking-[0.3em] text-[color:var(--muted)]">
                autoreason
              </p>
              <h1 className="max-w-3xl text-4xl font-semibold tracking-[-0.04em] text-balance sm:text-5xl">
                A calm control room for recursive argument hardening.
              </h1>
              <p className="max-w-2xl text-base leading-7 text-[color:var(--muted)] sm:text-lg">
                Launch the existing Python CLI from the browser, monitor long-running runs,
                and inspect the latest pro and counterargument without losing the original
                command-line workflow.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
              <div className="rounded-3xl border border-[color:var(--line)] bg-white/70 p-4">
                <p className="text-xs uppercase tracking-[0.22em] text-[color:var(--muted)]">
                  Active source
                </p>
                <p className="mt-2 text-2xl font-semibold">{runs.length}</p>
                <p className="mt-1 text-sm text-[color:var(--muted)]">Runs visible in `./runs`</p>
              </div>
              <div className="rounded-3xl border border-[color:var(--line)] bg-white/70 p-4">
                <p className="text-xs uppercase tracking-[0.22em] text-[color:var(--muted)]">
                  Selected
                </p>
                <p className="mt-2 text-lg font-semibold">{detailLabel(selectedRun)}</p>
                <p className="mt-1 text-sm text-[color:var(--muted)]">Auto-refreshes every 4s</p>
              </div>
              <div className="rounded-3xl border border-[color:var(--line)] bg-white/70 p-4">
                <p className="text-xs uppercase tracking-[0.22em] text-[color:var(--muted)]">
                  Current mode
                </p>
                <p className="mt-2 text-lg font-semibold">
                  {form.llmMode === "council" ? `${councilModels.length} model council` : "Single model"}
                </p>
                <p className="mt-1 text-sm text-[color:var(--muted)]">
                  {form.llmMode === "council"
                    ? "Peer ranking and chairman synthesis"
                    : "Direct CLI execution"}
                </p>
              </div>
            </div>
          </div>
        </header>

        <section className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
          <div className="space-y-6">
            <section className="panel p-6">
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[color:var(--muted)]">
                    Launch a run
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">
                    Compose the next dialectic
                  </h2>
                </div>
                {isRefreshing ? (
                  <span className="rounded-full bg-stone-200 px-3 py-1 text-xs font-medium text-stone-700">
                    Refreshing
                  </span>
                ) : null}
              </div>

              <div className="space-y-4">
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-stone-800">News text</span>
                  <textarea
                    value={form.newsText}
                    onChange={(event) => setForm((current) => ({ ...current, newsText: event.target.value }))}
                    placeholder="Paste the article, notes, or a cleaned summary here."
                    className="min-h-52 w-full rounded-3xl border border-[color:var(--line)] bg-white/85 px-4 py-4 text-sm leading-7 text-stone-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(45,106,95,0.12)]"
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium text-stone-800">Thesis hint</span>
                  <input
                    value={form.thesisHint}
                    onChange={(event) => setForm((current) => ({ ...current, thesisHint: event.target.value }))}
                    placeholder="Optional framing hint for the core issue."
                    className="w-full rounded-2xl border border-[color:var(--line)] bg-white/85 px-4 py-3 text-sm text-stone-900 outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(45,106,95,0.12)]"
                  />
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-2">
                    <span className="text-sm font-medium text-stone-800">Recursive depth</span>
                    <input
                      type="number"
                      min={1}
                      value={form.recursiveDepth}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          recursiveDepth: Number(event.target.value) || 1,
                        }))
                      }
                      className="w-full rounded-2xl border border-[color:var(--line)] bg-white/85 px-4 py-3 text-sm text-stone-900 outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(45,106,95,0.12)]"
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-sm font-medium text-stone-800">Rounds this session</span>
                    <input
                      type="number"
                      min={0}
                      value={form.maxRounds}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          maxRounds: Number(event.target.value) || 0,
                        }))
                      }
                      className="w-full rounded-2xl border border-[color:var(--line)] bg-white/85 px-4 py-3 text-sm text-stone-900 outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(45,106,95,0.12)]"
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-sm font-medium text-stone-800">Max minutes</span>
                    <input
                      type="number"
                      min={0}
                      placeholder="Optional"
                      value={form.maxMinutes}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          maxMinutes: event.target.value,
                        }))
                      }
                      className="w-full rounded-2xl border border-[color:var(--line)] bg-white/85 px-4 py-3 text-sm text-stone-900 outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(45,106,95,0.12)]"
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-sm font-medium text-stone-800">Judge every</span>
                    <input
                      type="number"
                      min={1}
                      value={form.judgeEvery}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          judgeEvery: Number(event.target.value) || 1,
                        }))
                      }
                      className="w-full rounded-2xl border border-[color:var(--line)] bg-white/85 px-4 py-3 text-sm text-stone-900 outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(45,106,95,0.12)]"
                    />
                  </label>
                </div>

                <div className="rounded-3xl border border-[color:var(--line)] bg-[rgba(250,247,241,0.92)] p-3">
                  <div className="flex rounded-full bg-white p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                    {(["single", "council"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setForm((current) => ({ ...current, llmMode: mode }))}
                        className={`flex-1 rounded-full px-4 py-2 text-sm font-medium transition ${
                          form.llmMode === mode
                            ? "bg-stone-950 text-stone-50 shadow-lg"
                            : "text-stone-600 hover:text-stone-900"
                        }`}
                      >
                        {mode === "single" ? "Single model" : "Council"}
                      </button>
                    ))}
                  </div>

                  {form.llmMode === "council" ? (
                    <div className="mt-4 space-y-3">
                      <label className="block space-y-2">
                        <span className="text-sm font-medium text-stone-800">Council models</span>
                        <textarea
                          value={form.councilModels}
                          onChange={(event) =>
                            setForm((current) => ({ ...current, councilModels: event.target.value }))
                          }
                          className="min-h-28 w-full rounded-2xl border border-[color:var(--line)] bg-white/85 px-4 py-3 text-sm leading-7 text-stone-900 outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(45,106,95,0.12)]"
                        />
                      </label>
                      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px]">
                        <label className="space-y-2">
                          <span className="text-sm font-medium text-stone-800">Chairman model</span>
                          <input
                            value={form.councilChairmanModel}
                            onChange={(event) =>
                              setForm((current) => ({
                                ...current,
                                councilChairmanModel: event.target.value,
                              }))
                            }
                            className="w-full rounded-2xl border border-[color:var(--line)] bg-white/85 px-4 py-3 text-sm text-stone-900 outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(45,106,95,0.12)]"
                          />
                        </label>
                        <label className="space-y-2">
                          <span className="text-sm font-medium text-stone-800">Workers</span>
                          <input
                            type="number"
                            min={1}
                            value={form.councilWorkers}
                            onChange={(event) =>
                              setForm((current) => ({
                                ...current,
                                councilWorkers: Number(event.target.value) || 1,
                              }))
                            }
                            className="w-full rounded-2xl border border-[color:var(--line)] bg-white/85 px-4 py-3 text-sm text-stone-900 outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[rgba(45,106,95,0.12)]"
                          />
                        </label>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-4 text-sm leading-6 text-[color:var(--muted)]">
                      Single-model mode launches the same CLI you already have, without council ranking or synthesis.
                    </p>
                  )}
                </div>

                <div className="rounded-3xl border border-[color:var(--line)] bg-stone-950 px-4 py-4 text-stone-50">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.22em] text-stone-400">
                        Under the hood
                      </p>
                      <p className="mt-1 text-sm text-stone-200">
                        The web app launches the same Python CLI in the parent repo.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={copyCommand}
                      className="rounded-full border border-white/15 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-stone-100 transition hover:border-white/35 hover:bg-white/8"
                    >
                      Copy command
                    </button>
                  </div>
                  <pre className="mt-4 overflow-x-auto rounded-2xl bg-black/20 p-4 text-xs leading-6 text-stone-300">
                    {selectedRun?.commandPreview || commandPreview}
                  </pre>
                </div>

                <button
                  type="button"
                  onClick={handleLaunch}
                  disabled={isLaunching}
                  className="inline-flex w-full items-center justify-center rounded-full bg-[var(--accent)] px-5 py-3.5 text-sm font-semibold text-white transition hover:bg-[color:var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isLaunching ? "Launching autoreason..." : "Start run"}
                </button>

                {errorMessage ? (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                    {errorMessage}
                  </div>
                ) : null}
                {copyFeedback ? (
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                    {copyFeedback}
                  </div>
                ) : null}
              </div>
            </section>

            <section className="panel p-6">
              <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[color:var(--muted)]">
                Workflow
              </p>
              <div className="mt-4 space-y-4 text-sm leading-7 text-[color:var(--muted)]">
                <p>
                  1. Paste a news item. 2. Choose single model or council mode. 3. Launch the run.
                </p>
                <p>
                  The API route writes your article into the run folder, spawns the Python CLI, then
                  polls `checkpoint.json` and `latest.md` just like a human operator would.
                </p>
                <p>
                  This keeps the repo honest: the CLI remains the canonical engine, and the browser is
                  just a calmer way to drive it.
                </p>
              </div>
            </section>
          </div>

          <div className="grid gap-6 lg:grid-rows-[minmax(260px,320px)_minmax(420px,1fr)]">
            <section className="panel overflow-hidden">
              <div className="flex items-center justify-between border-b border-[color:var(--line)] px-6 py-5">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[color:var(--muted)]">
                    Run browser
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">
                    Recent sessions
                  </h2>
                </div>
                <span className="rounded-full bg-stone-200 px-3 py-1 text-xs font-medium text-stone-700">
                  {runs.length} total
                </span>
              </div>

              <div className="max-h-[26rem] overflow-y-auto px-3 py-3">
                {runs.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-[color:var(--line)] px-5 py-10 text-center text-sm text-[color:var(--muted)]">
                    No runs yet. Launch one from the panel on the left.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {runs.map((run) => (
                      <button
                        key={run.id}
                        type="button"
                        onClick={() => startTransition(() => setSelectedRunId(run.id))}
                        className={`w-full rounded-3xl border px-4 py-4 text-left transition ${
                          selectedRunId === run.id
                            ? "border-[var(--accent)] bg-[var(--accent-soft)] shadow-[0_18px_40px_rgba(42,91,82,0.12)]"
                            : "border-[color:var(--line)] bg-white/70 hover:bg-white"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <p className="truncate text-base font-semibold text-stone-900">
                            {run.issue || run.id}
                          </p>
                          <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusTone(run.status)}`}>
                            {run.status}
                          </span>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-3 text-sm text-[color:var(--muted)]">
                          <span>{run.llmMode === "council" ? "Council" : "Single model"}</span>
                          <span>Round {run.roundNumber}</span>
                          <span>{formatTimestamp(run.updatedAt)}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="panel overflow-hidden">
              <div className="border-b border-[color:var(--line)] px-6 py-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[color:var(--muted)]">
                      Live detail
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">
                      {selectedRun?.issue || "Waiting for a run"}
                    </h2>
                  </div>
                  {selectedRun ? (
                    <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusTone(selectedRun.status)}`}>
                      {selectedRun.status}
                    </span>
                  ) : null}
                </div>
                {selectedRun ? (
                  <div className="mt-4 flex flex-wrap gap-3 text-sm text-[color:var(--muted)]">
                    <span>Source: {selectedRun.sourceLabel}</span>
                    <span>Rounds: {selectedRun.roundNumber}</span>
                    <span>Updated: {formatTimestamp(selectedRun.updatedAt)}</span>
                  </div>
                ) : null}
              </div>

              <div className="space-y-6 px-6 py-6">
                {selectedRun ? (
                  <>
                    <div className="grid gap-4 xl:grid-cols-2">
                      <article className="rounded-[28px] border border-[rgba(42,91,82,0.14)] bg-[rgba(225,244,238,0.72)] p-5">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[color:var(--accent)]">
                          Pro argument
                        </p>
                        <h3 className="mt-2 text-xl font-semibold tracking-[-0.03em]">
                          {selectedRun.pro?.headline || "Waiting for first checkpoint"}
                        </h3>
                        <p className="mt-3 text-sm leading-7 text-stone-700">
                          {selectedRun.pro?.argument || "The current strongest affirmative case will appear here."}
                        </p>
                      </article>

                      <article className="rounded-[28px] border border-[rgba(143,85,46,0.14)] bg-[rgba(251,239,222,0.82)] p-5">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[color:var(--accent-warm)]">
                          Counterargument
                        </p>
                        <h3 className="mt-2 text-xl font-semibold tracking-[-0.03em]">
                          {selectedRun.con?.headline || "Waiting for first checkpoint"}
                        </h3>
                        <p className="mt-3 text-sm leading-7 text-stone-700">
                          {selectedRun.con?.argument || "The strongest opposing case will appear here."}
                        </p>
                      </article>
                    </div>

                    <div className="grid gap-4 xl:grid-cols-[0.72fr_1fr]">
                      <section className="rounded-[28px] border border-[color:var(--line)] bg-white/72 p-5">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[color:var(--muted)]">
                          Snapshot
                        </p>
                        <dl className="mt-4 grid gap-3 text-sm">
                          <div className="flex items-start justify-between gap-4">
                            <dt className="text-[color:var(--muted)]">Run id</dt>
                            <dd className="text-right font-medium text-stone-900">{selectedRun.id}</dd>
                          </div>
                          <div className="flex items-start justify-between gap-4">
                            <dt className="text-[color:var(--muted)]">LLM mode</dt>
                            <dd className="text-right font-medium text-stone-900">{selectedRun.llmMode}</dd>
                          </div>
                          <div className="flex items-start justify-between gap-4">
                            <dt className="text-[color:var(--muted)]">Created</dt>
                            <dd className="text-right font-medium text-stone-900">
                              {formatTimestamp(selectedRun.createdAt)}
                            </dd>
                          </div>
                          <div className="flex items-start justify-between gap-4">
                            <dt className="text-[color:var(--muted)]">Command</dt>
                            <dd className="max-w-[16rem] text-right font-medium text-stone-900">
                              Python CLI launched by route handler
                            </dd>
                          </div>
                        </dl>
                      </section>

                      <section className="rounded-[28px] border border-[color:var(--line)] bg-stone-950 text-stone-50">
                        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-400">
                              Latest report
                            </p>
                            <p className="mt-1 text-sm text-stone-300">
                              This is the current `latest.md` from the run folder.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={copyCommand}
                            className="rounded-full border border-white/15 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-stone-100 transition hover:border-white/35 hover:bg-white/8"
                          >
                            Copy launch cmd
                          </button>
                        </div>
                        <pre className="max-h-[38rem] overflow-auto whitespace-pre-wrap px-5 py-5 text-sm leading-7 text-stone-200">
                          {selectedRun.reportMarkdown || "No report yet. The CLI is probably still bootstrapping."}
                        </pre>
                      </section>
                    </div>
                  </>
                ) : (
                  <div className="rounded-[28px] border border-dashed border-[color:var(--line)] px-6 py-14 text-center text-sm leading-7 text-[color:var(--muted)]">
                    Pick a run from the browser or launch a new one to inspect its latest arguments.
                  </div>
                )}
              </div>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}
