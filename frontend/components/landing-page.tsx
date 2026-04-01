"use client";

import { startTransition, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { LaunchRunRequest, LlmMode } from "@/lib/types";

const MODEL_SETTINGS_STORAGE_KEY = "autoreason.settings.v1";
const API_KEY_STORAGE_KEY = "autoreason.api-key.v1";

const MODES: Array<{ value: LlmMode; label: string }> = [
  { value: "single", label: "single model" },
  { value: "council", label: "council" },
];

const MODEL_OPTIONS = [
  { value: "default", label: "System default" },
  { value: "gpt-5", label: "GPT-5" },
  { value: "gpt-5-mini", label: "GPT-5 mini" },
  { value: "gpt-4.1", label: "GPT-4.1" },
  { value: "o4-mini", label: "o4-mini" },
  { value: "custom", label: "Custom model" },
] as const;

function isValidUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function SettingsIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-[18px] w-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3.25" />
      <path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 0 1-4 0v-.2a1 1 0 0 0-.7-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a2 2 0 0 1 0-4h.2a1 1 0 0 0 .9-.7 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2h.1a1 1 0 0 0 .6-.9V4a2 2 0 0 1 4 0v.2a1 1 0 0 0 .7.9 1 1 0 0 0 1.1-.2l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1v.1a1 1 0 0 0 .9.6h.2a2 2 0 0 1 0 4h-.2a1 1 0 0 0-.9.7Z" />
    </svg>
  );
}

export function LandingPage() {
  const router = useRouter();
  const [articleUrl, setArticleUrl] = useState("");
  const [llmMode, setLlmMode] = useState<LlmMode>("single");
  const [selectedModel, setSelectedModel] = useState<(typeof MODEL_OPTIONS)[number]["value"]>("default");
  const [customModel, setCustomModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [isLaunching, setIsLaunching] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsPanelRef = useRef<HTMLDivElement | null>(null);

  const resolvedModel =
    selectedModel === "custom"
      ? customModel.trim()
      : selectedModel === "default"
        ? ""
        : selectedModel;
  const hasCustomSettings = Boolean(resolvedModel || apiKey.trim());

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

  useEffect(() => {
    if (!settingsOpen) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (
        target &&
        !settingsPanelRef.current?.contains(target) &&
        !settingsButtonRef.current?.contains(target)
      ) {
        setSettingsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSettingsOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [settingsOpen]);

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
      setSettingsOpen(true);
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
        <div className="fixed right-4 top-4 z-30 sm:right-6 sm:top-6">
          <button
            ref={settingsButtonRef}
            type="button"
            onClick={() => {
              setSettingsOpen((current) => !current);
              setErrorMessage("");
            }}
            className="relative inline-flex h-10 w-10 items-center justify-center rounded-full border border-foreground/10 bg-white/88 text-foreground/44 shadow-[0_10px_30px_rgba(15,23,42,0.06)] backdrop-blur-sm hover:text-foreground"
            aria-label="Open settings"
            aria-expanded={settingsOpen}
          >
            <SettingsIcon />
            {hasCustomSettings ? (
              <span className="absolute right-[0.82rem] top-[0.82rem] h-1.5 w-1.5 rounded-full bg-foreground" />
            ) : null}
          </button>

          {settingsOpen ? (
            <div
              ref={settingsPanelRef}
              className="absolute right-0 top-12 w-[min(24rem,calc(100vw-2rem))] rounded-[1.75rem] border border-foreground/10 bg-white/94 p-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur-sm sm:w-[24rem] sm:p-6"
            >
              <div className="space-y-2">
                <p className="text-[11px] uppercase tracking-[0.34em] text-foreground/32">settings</p>
                <p className="max-w-sm text-sm leading-7 text-foreground/54">
                  Choose the model for single runs and add your own API key. Model preferences are
                  saved in this browser, while the key stays with this session and is never written
                  into the run files.
                </p>
              </div>

              <div className="mt-6 space-y-5">
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
                  <button
                    type="button"
                    onClick={() => setSettingsOpen(false)}
                    className="rounded-full bg-foreground px-4 py-2 text-background"
                  >
                    done
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="mb-8 text-center">
          <p className="text-2xl font-medium tracking-[0.26em] text-foreground/48 uppercase sm:text-3xl">
            autoreason
          </p>
        </div>

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

          {errorMessage ? <p className="text-center text-sm text-rose-500">{errorMessage}</p> : null}
        </form>
      </div>
    </main>
  );
}
