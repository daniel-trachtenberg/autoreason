"use client";

import { startTransition, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import type { LaunchRunRequest, LlmMode } from "@/lib/types";

const MODEL_SETTINGS_STORAGE_KEY = "autoreason.settings.v1";
const API_KEY_STORAGE_KEY = "autoreason.api-key.v1";

const MODES: Array<{ value: LlmMode; label: string }> = [
  { value: "single", label: "single model" },
  { value: "council", label: "council" },
];

const HOME_TABS = [
  { value: "start", label: "start" },
  { value: "settings", label: "settings" },
] as const;

const MODEL_OPTIONS = [
  { value: "default", label: "System default" },
  { value: "gpt-5", label: "GPT-5" },
  { value: "gpt-5-mini", label: "GPT-5 mini" },
  { value: "gpt-4.1", label: "GPT-4.1" },
  { value: "o4-mini", label: "o4-mini" },
  { value: "custom", label: "Custom model" },
] as const;

type HomeTab = (typeof HOME_TABS)[number]["value"];

function isValidUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function LandingPage() {
  const router = useRouter();
  const [articleUrl, setArticleUrl] = useState("");
  const [homeTab, setHomeTab] = useState<HomeTab>("start");
  const [llmMode, setLlmMode] = useState<LlmMode>("single");
  const [selectedModel, setSelectedModel] = useState<(typeof MODEL_OPTIONS)[number]["value"]>("default");
  const [customModel, setCustomModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [isLaunching, setIsLaunching] = useState(false);

  const resolvedModel =
    selectedModel === "custom"
      ? customModel.trim()
      : selectedModel === "default"
        ? ""
        : selectedModel;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(MODEL_SETTINGS_STORAGE_KEY);
      const savedApiKey = window.sessionStorage.getItem(API_KEY_STORAGE_KEY);
      if (!raw && !savedApiKey) return;

      const saved = raw
        ? (JSON.parse(raw) as {
            selectedModel?: (typeof MODEL_OPTIONS)[number]["value"];
            customModel?: string;
          })
        : {};

      if (saved.selectedModel && MODEL_OPTIONS.some((option) => option.value === saved.selectedModel)) {
        setSelectedModel(saved.selectedModel);
      }
      if (saved.customModel) {
        setCustomModel(saved.customModel);
      }
      if (savedApiKey) {
        setApiKey(savedApiKey);
      }
    } catch {
      // Ignore storage failures so the page can continue to function normally.
    }
  }, []);

  useEffect(() => {
    try {
      if (selectedModel === "default" && !customModel.trim()) {
        window.localStorage.removeItem(MODEL_SETTINGS_STORAGE_KEY);
      } else {
        window.localStorage.setItem(
          MODEL_SETTINGS_STORAGE_KEY,
          JSON.stringify({
            selectedModel,
            customModel,
          }),
        );
      }

      if (!apiKey.trim()) {
        window.sessionStorage.removeItem(API_KEY_STORAGE_KEY);
      } else {
        window.sessionStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
      }
    } catch {
      // Ignore storage failures so the page can continue to function normally.
    }
  }, [selectedModel, customModel, apiKey]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedUrl = articleUrl.trim();
    const trimmedApiKey = apiKey.trim();

    setErrorMessage("");
    if (!trimmedUrl) {
      setErrorMessage("Paste an article URL to start.");
      return;
    }
    if (!isValidUrl(trimmedUrl)) {
      setErrorMessage("Enter a valid http or https article URL.");
      return;
    }
    if (selectedModel === "custom" && !resolvedModel) {
      setHomeTab("settings");
      setErrorMessage("Add a custom model ID in settings before starting.");
      return;
    }

    const payload: LaunchRunRequest = {
      articleUrl: trimmedUrl,
      llmMode,
      model: resolvedModel || undefined,
      apiKey: trimmedApiKey || undefined,
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
      startTransition(() => {
        router.push(`/runs/${created.runId}`);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start the run.";
      setErrorMessage(message);
      setIsLaunching(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-4xl">
        <div className="mb-8 text-center">
          <p className="text-2xl font-medium tracking-[0.26em] text-foreground/48 uppercase sm:text-3xl">
            autoreason
          </p>
        </div>

        <div className="mb-8 flex justify-center">
          <div className="flex items-center gap-1 rounded-full border border-foreground/10 bg-white/80 p-1 shadow-[0_12px_40px_rgba(15,23,42,0.05)]">
            {HOME_TABS.map((tab) => {
              const active = tab.value === homeTab;
              return (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => {
                    setHomeTab(tab.value);
                    setErrorMessage("");
                  }}
                  className={`rounded-full px-4 py-2 text-sm ${
                    active
                      ? "bg-foreground text-background shadow-sm"
                      : "text-foreground/56 hover:text-foreground"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {homeTab === "start" ? (
          <form className="space-y-6" onSubmit={handleSubmit}>
            <div className="mx-auto flex w-fit items-center gap-1 rounded-full border border-foreground/10 bg-white/80 p-1 shadow-[0_12px_40px_rgba(15,23,42,0.05)]">
              {MODES.map((mode) => {
                const active = mode.value === llmMode;
                return (
                  <button
                    key={mode.value}
                    type="button"
                    onClick={() => setLlmMode(mode.value)}
                    className={`rounded-full px-4 py-2 text-sm ${
                      active
                        ? "bg-foreground text-background shadow-sm"
                        : "text-foreground/56 hover:text-foreground"
                    }`}
                  >
                    {mode.label}
                  </button>
                );
              })}
            </div>

            <div className="mx-auto max-w-3xl">
              <label
                className={`flex items-center gap-3 rounded-[2rem] border bg-white px-6 py-4 shadow-[0_24px_80px_rgba(15,23,42,0.07)] ${
                  errorMessage ? "border-rose-300" : "border-foreground/10"
                }`}
              >
                <input
                  type="url"
                  name="articleUrl"
                  autoComplete="off"
                  autoFocus
                  value={articleUrl}
                  onChange={(event) => setArticleUrl(event.target.value)}
                  placeholder="Paste an article URL"
                  className="w-full border-none bg-transparent text-lg text-foreground outline-none placeholder:text-foreground/28"
                  aria-label="Article URL"
                />
                <button
                  type="submit"
                  disabled={isLaunching}
                  className="rounded-full bg-foreground px-4 py-2 text-sm text-background disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isLaunching ? "starting" : "enter"}
                </button>
              </label>
            </div>

            {resolvedModel || apiKey.trim() ? (
              <div className="text-center text-sm text-foreground/34">
                {resolvedModel ? `${resolvedModel}` : "system default model"}
                {apiKey.trim() ? " · personal API key active" : ""}
              </div>
            ) : null}

            {errorMessage ? <p className="text-center text-sm text-rose-500">{errorMessage}</p> : null}
          </form>
        ) : (
          <section className="mx-auto max-w-2xl rounded-[2rem] border border-foreground/10 bg-white/84 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.06)] sm:p-8">
            <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-[0.34em] text-foreground/32">settings</p>
              <p className="max-w-lg text-sm leading-7 text-foreground/54">
                Choose the model for single runs and add your own API key. Model preferences are
                saved in this browser, while the key is kept to this session and forwarded to the
                Python process without being written into the run files.
              </p>
            </div>

            <div className="mt-8 space-y-6">
              <label className="block space-y-3">
                <span className="text-sm text-foreground/54">Model</span>
                <select
                  value={selectedModel}
                  onChange={(event) =>
                    setSelectedModel(event.target.value as (typeof MODEL_OPTIONS)[number]["value"])
                  }
                  className="w-full rounded-2xl border border-foreground/10 bg-background/70 px-4 py-3 text-base text-foreground outline-none focus:border-foreground/30"
                >
                  {MODEL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              {selectedModel === "custom" ? (
                <label className="block space-y-3">
                  <span className="text-sm text-foreground/54">Custom model ID</span>
                  <input
                    type="text"
                    value={customModel}
                    onChange={(event) => setCustomModel(event.target.value)}
                    placeholder="gpt-5 or anthropic/claude-sonnet-4"
                    className="w-full rounded-2xl border border-foreground/10 bg-background/70 px-4 py-3 text-base text-foreground outline-none placeholder:text-foreground/24 focus:border-foreground/30"
                  />
                </label>
              ) : null}

              <label className="block space-y-3">
                <span className="text-sm text-foreground/54">API key</span>
                <div className="flex items-center gap-3 rounded-2xl border border-foreground/10 bg-background/70 px-4 py-3">
                  <input
                    type={showApiKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="sk-..."
                    className="w-full border-none bg-transparent text-base text-foreground outline-none placeholder:text-foreground/24"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey((current) => !current)}
                    className="text-sm text-foreground/42 hover:text-foreground"
                  >
                    {showApiKey ? "hide" : "show"}
                  </button>
                </div>
              </label>

              <div className="flex items-center justify-between gap-4 border-t border-foreground/8 pt-5 text-sm">
                <p className="text-foreground/38">Uses the current server OpenAI-compatible base URL.</p>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedModel("default");
                    setCustomModel("");
                    setApiKey("");
                    setShowApiKey(false);
                    setErrorMessage("");
                  }}
                  className="rounded-full border border-foreground/10 px-4 py-2 text-foreground/58 hover:text-foreground"
                >
                  clear
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
