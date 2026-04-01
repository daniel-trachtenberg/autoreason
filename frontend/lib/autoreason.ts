import "server-only";

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ArgumentView, LaunchRunRequest, LlmMode, RunDetail, RunStatus, RunSummary } from "@/lib/types";

type CheckpointPayload = {
  run_id?: string;
  created_at?: string;
  updated_at?: string;
  source_label?: string;
  issue?: string;
  round_number?: number;
  pro?: Record<string, unknown>;
  con?: Record<string, unknown>;
  config_snapshot?: Record<string, unknown>;
};

type WebRunState = {
  status: RunStatus;
  launchedAt: string;
  updatedAt: string;
  completedAt?: string;
  pid?: number;
  sourceLabel?: string;
  modelLabel?: string;
  commandPreview: string;
  error?: string;
  exitCode?: number | null;
};

const repoRoot = path.resolve(/* turbopackIgnore: true */ process.cwd(), "..");
const runsRoot = path.join(repoRoot, "runs");
const pythonBin = process.env.AUTOREASON_PYTHON_BIN || "python3";
const DEFAULT_RECURSIVE_DEPTH = 2;
const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_JUDGE_EVERY = 1;
const DEFAULT_PAUSE_SECONDS = 0;
const DEFAULT_COUNCIL_WORKERS = 4;

type ResolvedLaunchRunRequest = {
  articleUrl?: string;
  newsText?: string;
  model?: string;
  apiKey?: string;
  thesisHint?: string;
  recursiveDepth: number;
  maxRounds: number;
  maxMinutes?: number | null;
  judgeEvery: number;
  pauseSeconds: number;
  llmMode: LlmMode;
  councilModels: string[];
  councilChairmanModel?: string;
  councilWorkers: number;
};

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "session";
}

function timestampLabel() {
  return new Date()
    .toISOString()
    .replace(/[:-]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
}

function shellEscape(value: string) {
  if (/^[a-zA-Z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseModelList(value: string | string[] | undefined) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  const models: string[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    for (const rawModel of item.split(",")) {
      const model = rawModel.trim();
      if (model && !seen.has(model)) {
        seen.add(model);
        models.push(model);
      }
    }
  }

  return models;
}

function buildPythonPath() {
  const srcPath = path.join(repoRoot, "src");
  return process.env.PYTHONPATH ? `${srcPath}:${process.env.PYTHONPATH}` : srcPath;
}

function resolveLaunchRequest(request: LaunchRunRequest): ResolvedLaunchRunRequest {
  const selectedModel = request.model?.trim() || "";

  return {
    articleUrl: request.articleUrl?.trim() || undefined,
    newsText: request.newsText?.trim() || undefined,
    model: selectedModel || process.env.AUTOREASON_MODEL || undefined,
    apiKey: request.apiKey?.trim() || process.env.AUTOREASON_API_KEY || undefined,
    thesisHint: request.thesisHint?.trim() || undefined,
    recursiveDepth: Math.max(1, request.recursiveDepth ?? DEFAULT_RECURSIVE_DEPTH),
    maxRounds: Math.max(0, request.maxRounds ?? DEFAULT_MAX_ROUNDS),
    maxMinutes: request.maxMinutes ?? null,
    judgeEvery: Math.max(1, request.judgeEvery ?? DEFAULT_JUDGE_EVERY),
    pauseSeconds: Math.max(0, request.pauseSeconds ?? DEFAULT_PAUSE_SECONDS),
    llmMode: request.llmMode,
    councilModels: parseModelList(
      request.councilModels && request.councilModels.length > 0
        ? request.councilModels
        : process.env.AUTOREASON_COUNCIL_MODELS,
    ),
    councilChairmanModel:
      request.councilChairmanModel?.trim() ||
      (request.llmMode === "council" ? selectedModel : "") ||
      process.env.AUTOREASON_COUNCIL_CHAIRMAN_MODEL ||
      undefined,
    councilWorkers: Math.max(
      1,
      request.councilWorkers ?? Number(process.env.AUTOREASON_COUNCIL_WORKERS || DEFAULT_COUNCIL_WORKERS),
    ),
  };
}

function seedFromUrl(value: string) {
  try {
    const url = new URL(value);
    const pathParts = url.pathname.split("/").filter(Boolean).slice(-2).join(" ");
    return `${url.hostname} ${pathParts}`.trim();
  } catch {
    return value;
  }
}

function buildArgumentView(payload: Record<string, unknown> | undefined): ArgumentView | null {
  if (!payload) return null;
  return {
    headline: String(payload.headline || ""),
    argument: String(payload.argument || ""),
    claims: Array.isArray(payload.claims) ? payload.claims.map(String) : [],
    concessions: Array.isArray(payload.concessions) ? payload.concessions.map(String) : [],
    openQuestions: Array.isArray(payload.open_questions) ? payload.open_questions.map(String) : [],
    nextTargets: Array.isArray(payload.next_targets) ? payload.next_targets.map(String) : [],
  };
}

async function ensureRunsRoot() {
  await mkdir(runsRoot, { recursive: true });
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readText(filePath: string) {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function writeWebState(runDir: string, partial: Partial<WebRunState>) {
  const filePath = path.join(runDir, "web.json");
  const existing = (await readJson<WebRunState>(filePath)) || {
    status: "launching" as RunStatus,
    launchedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    commandPreview: "",
  };
  const nextState: WebRunState = {
    ...existing,
    ...partial,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(filePath, JSON.stringify(nextState, null, 2) + "\n", "utf-8");
}

function buildRunCommand(runDir: string, request: ResolvedLaunchRunRequest) {
  const newsPath = path.join(runDir, "submitted-news.txt");
  const args = [
    "-m",
    "autoreason",
    "run",
    "--run-dir",
    runDir,
    "--recursive-depth",
    String(request.recursiveDepth),
    "--max-rounds",
    String(request.maxRounds),
    "--judge-every",
    String(request.judgeEvery),
    "--pause-seconds",
    String(request.pauseSeconds),
  ];

  if (request.articleUrl) {
    args.push("--url", request.articleUrl);
  } else {
    args.push("--news-file", newsPath);
  }

  if (request.maxMinutes !== null && request.maxMinutes !== undefined) {
    args.push("--max-minutes", String(request.maxMinutes));
  }
  if (request.thesisHint) {
    args.push("--thesis-hint", request.thesisHint);
  }
  if (request.llmMode === "council") {
    args.push("--llm-mode", "council");
    for (const model of request.councilModels) {
      args.push("--council-model", model);
    }
    if (request.councilChairmanModel) {
      args.push("--council-chairman-model", request.councilChairmanModel);
    }
    args.push("--council-workers", String(request.councilWorkers));
  }

  const commandPreview = [
    `PYTHONPATH=${shellEscape(buildPythonPath())}`,
    ...(request.model ? [`AUTOREASON_MODEL=${shellEscape(request.model)}`] : []),
    pythonBin,
    ...args.map(shellEscape),
  ].join(" ");

  return { newsPath, args, commandPreview };
}

async function readSummaryFromRun(runId: string): Promise<RunSummary> {
  const runDir = path.join(runsRoot, runId);
  const checkpoint = await readJson<CheckpointPayload>(path.join(runDir, "checkpoint.json"));
  const webState = await readJson<WebRunState>(path.join(runDir, "web.json"));
  const snapshot = checkpoint?.config_snapshot || {};
  const llmMode = (snapshot.llm_mode as LlmMode) || "single";

  return {
    id: runId,
    issue: checkpoint?.issue || "Bootstrapping issue statement",
    sourceLabel: checkpoint?.source_label || webState?.sourceLabel || "",
    modelLabel: webState?.modelLabel || "",
    roundNumber: Number(checkpoint?.round_number || 0),
    updatedAt: checkpoint?.updated_at || webState?.updatedAt || webState?.launchedAt || "",
    status: webState?.status || (checkpoint ? "completed" : "idle"),
    llmMode,
  };
}

export async function listRuns() {
  await ensureRunsRoot();
  const entries = await readdir(runsRoot, { withFileTypes: true });
  const runIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const summaries = await Promise.all(runIds.map((runId) => readSummaryFromRun(runId)));
  return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readRunDetail(runId: string): Promise<RunDetail> {
  await ensureRunsRoot();
  const runDir = path.join(runsRoot, runId);
  const checkpoint = await readJson<CheckpointPayload>(path.join(runDir, "checkpoint.json"));
  const webState = await readJson<WebRunState>(path.join(runDir, "web.json"));
  const reportMarkdown = await readText(path.join(runDir, "latest.md"));
  const snapshot = checkpoint?.config_snapshot || {};
  const llmMode = (snapshot.llm_mode as LlmMode) || "single";

  return {
    id: runId,
    issue: checkpoint?.issue || "Bootstrapping issue statement",
    sourceLabel: checkpoint?.source_label || webState?.sourceLabel || "",
    modelLabel: webState?.modelLabel || "",
    roundNumber: Number(checkpoint?.round_number || 0),
    updatedAt: checkpoint?.updated_at || webState?.updatedAt || "",
    createdAt: checkpoint?.created_at || webState?.launchedAt || "",
    status: webState?.status || (checkpoint ? "completed" : "idle"),
    llmMode,
    reportMarkdown,
    commandPreview: webState?.commandPreview || "",
    pro: buildArgumentView(checkpoint?.pro),
    con: buildArgumentView(checkpoint?.con),
  };
}

export async function launchRun(request: LaunchRunRequest) {
  const resolved = resolveLaunchRequest(request);
  await ensureRunsRoot();
  const seed =
    resolved.thesisHint ||
    (resolved.articleUrl ? seedFromUrl(resolved.articleUrl) : resolved.newsText?.split(/\s+/).slice(0, 6).join(" ")) ||
    "session";
  const runId = `${timestampLabel()}-${slugify(seed)}`;
  const runDir = path.join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });

  const { newsPath, args, commandPreview } = buildRunCommand(runDir, resolved);
  if (resolved.newsText) {
    await writeFile(newsPath, resolved.newsText + "\n", "utf-8");
  }
  await writeWebState(runDir, {
    status: "launching",
    launchedAt: new Date().toISOString(),
    sourceLabel: resolved.articleUrl,
    modelLabel: resolved.model,
    commandPreview,
  });

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONPATH: buildPythonPath(),
  };

  if (resolved.apiKey) {
    childEnv.AUTOREASON_API_KEY = resolved.apiKey;
  }
  if (resolved.model) {
    childEnv.AUTOREASON_MODEL = resolved.model;
  }

  const child = spawn(pythonBin, args, {
    cwd: repoRoot,
    env: childEnv,
    stdio: "ignore",
  });

  child.once("spawn", () => {
    void writeWebState(runDir, {
      status: "running",
      pid: child.pid,
    });
  });

  child.once("error", (error) => {
    void writeWebState(runDir, {
      status: "failed",
      error: error.message,
      exitCode: null,
      completedAt: new Date().toISOString(),
    });
  });

  child.once("exit", (code) => {
    void writeWebState(runDir, {
      status: code === 0 ? "completed" : "failed",
      exitCode: code,
      completedAt: new Date().toISOString(),
    });
  });

  child.unref();

  return {
    runId,
    commandPreview,
  };
}
