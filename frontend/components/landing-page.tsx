"use client";

import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";

import type { LaunchRunRequest, LlmMode } from "@/lib/types";

const MODES: Array<{ value: LlmMode; label: string }> = [
  { value: "single", label: "single model" },
  { value: "council", label: "council" },
];

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
  const [llmMode, setLlmMode] = useState<LlmMode>("single");
  const [errorMessage, setErrorMessage] = useState("");
  const [isLaunching, setIsLaunching] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedUrl = articleUrl.trim();

    setErrorMessage("");
    if (!trimmedUrl) {
      setErrorMessage("Paste an article URL to start.");
      return;
    }
    if (!isValidUrl(trimmedUrl)) {
      setErrorMessage("Enter a valid http or https article URL.");
      return;
    }

    const payload: LaunchRunRequest = {
      articleUrl: trimmedUrl,
      llmMode,
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
          <p className="text-[11px] font-medium tracking-[0.48em] text-foreground/38 uppercase">
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
