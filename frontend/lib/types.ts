export type LlmMode = "single" | "council";

export type LaunchRunRequest = {
  articleUrl?: string;
  newsText?: string;
  model?: string;
  apiKey?: string;
  thesisHint?: string;
  recursiveDepth?: number;
  maxRounds?: number;
  maxMinutes?: number | null;
  judgeEvery?: number;
  pauseSeconds?: number;
  llmMode: LlmMode;
  councilModels?: string[];
  councilChairmanModel?: string;
  councilWorkers?: number;
};

export type RunStatus = "idle" | "launching" | "running" | "completed" | "failed";

export type ArgumentView = {
  headline: string;
  argument: string;
  claims: string[];
  concessions: string[];
  openQuestions: string[];
  nextTargets: string[];
};

export type RunSummary = {
  id: string;
  issue: string;
  sourceLabel: string;
  modelLabel?: string;
  roundNumber: number;
  updatedAt: string;
  status: RunStatus;
  llmMode: LlmMode;
};

export type RunDetail = RunSummary & {
  createdAt: string;
  reportMarkdown: string;
  commandPreview: string;
  pro: ArgumentView | null;
  con: ArgumentView | null;
};
