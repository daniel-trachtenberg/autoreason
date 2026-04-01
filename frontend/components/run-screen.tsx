"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useEffectEvent, useState } from "react";

import type { ArgumentView, RunDetail } from "@/lib/types";

const POLL_INTERVAL_MS = 3000;

async function requestRunDetail(runId: string) {
  const response = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as RunDetail;
}

function formatTimestamp(value: string) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function statusLabel(detail: RunDetail | null) {
  if (!detail) return "connecting";
  if (detail.status === "launching") return "starting";
  if (detail.status === "running") return "reasoning";
  if (detail.status === "completed") return "complete";
  if (detail.status === "failed") return "failed";
  return detail.status;
}

function summaryText(detail: RunDetail | null) {
  if (!detail) return "Warming up the run.";
  if (detail.status === "completed") return "Final pass complete.";
  if (detail.status === "failed") return "This run stopped before finishing.";
  return `Round ${Math.max(detail.roundNumber, 0)} in progress.`;
}

function modeSummary(detail: RunDetail | null) {
  const modeLabel = detail?.llmMode === "council" ? "council" : "single model";
  return detail?.modelLabel ? `${modeLabel} · ${detail.modelLabel}` : modeLabel;
}

function ArgumentPanel({
  label,
  title,
  argument,
}: {
  label: string;
  title: string;
  argument: ArgumentView;
}) {
  return (
    <article className="result-panel">
      <div className="mb-10 flex items-center justify-between text-[11px] uppercase tracking-[0.38em] text-foreground/35">
        <span>{label}</span>
        <span>{title}</span>
      </div>

      <div className="space-y-8">
        <div className="space-y-4">
          <h2 className="text-3xl leading-tight font-medium text-foreground sm:text-4xl">
            {argument.headline || title}
          </h2>
          <p className="text-base leading-8 text-foreground/72 sm:text-lg">{argument.argument}</p>
        </div>

        {argument.claims.length > 0 ? (
          <div className="space-y-3">
            <p className="text-[11px] uppercase tracking-[0.32em] text-foreground/32">
              key points
            </p>
            <ul className="space-y-3 text-sm leading-7 text-foreground/62">
              {argument.claims.slice(0, 5).map((claim) => (
                <li key={claim} className="border-t border-foreground/8 pt-3">
                  {claim}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function RunScreen({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  const deferredReport = useDeferredValue(detail?.reportMarkdown ?? "");

  const loadRunDetail = useEffectEvent(async () => {
    try {
      const nextDetail = await requestRunDetail(runId);
      setDetail(nextDetail);
      setErrorMessage("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load the run.";
      setErrorMessage(message);
    }
  });

  useEffect(() => {
    void loadRunDetail();
    const interval = window.setInterval(() => {
      void loadRunDetail();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [runId]);

  if (errorMessage) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="w-full max-w-xl text-center">
          <p className="text-[11px] uppercase tracking-[0.42em] text-foreground/35">autoreason</p>
          <div className="mt-8 rounded-[2rem] border border-rose-200 bg-white p-8 shadow-[0_18px_60px_rgba(15,23,42,0.06)]">
            <p className="text-lg text-foreground">{errorMessage}</p>
            <Link
              href="/"
              className="mt-6 inline-flex rounded-full border border-foreground/10 px-4 py-2 text-sm text-foreground/64 hover:text-foreground"
            >
              back
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (detail?.status === "failed") {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="w-full max-w-2xl text-center">
          <p className="text-[11px] uppercase tracking-[0.42em] text-foreground/35">autoreason</p>
          <div className="mt-10 space-y-6">
            <p className="text-sm uppercase tracking-[0.28em] text-foreground/32">run failed</p>
            <h1 className="text-4xl leading-tight font-medium text-foreground">
              {detail.issue || "This run did not finish cleanly."}
            </h1>
            <p className="mx-auto max-w-xl text-base leading-8 text-foreground/58">
              {deferredReport || "The model run exited before the final arguments were produced."}
            </p>
            <Link
              href="/"
              className="inline-flex rounded-full border border-foreground/10 px-4 py-2 text-sm text-foreground/64 hover:text-foreground"
            >
              start over
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (detail?.status === "completed" && detail.pro && detail.con) {
    return (
      <main className="min-h-screen px-6 py-8 sm:px-8">
        <header className="mx-auto flex w-full max-w-6xl items-center justify-between">
          <Link href="/" className="text-[11px] uppercase tracking-[0.42em] text-foreground/35">
            autoreason
          </Link>
          <div className="text-right">
            <p className="text-[11px] tracking-[0.18em] text-foreground/28">{modeSummary(detail)}</p>
            <p className="mt-2 text-sm text-foreground/44">{formatTimestamp(detail.updatedAt)}</p>
          </div>
        </header>

        <section className="mx-auto mt-10 max-w-4xl text-center">
          <p className="text-[11px] uppercase tracking-[0.32em] text-foreground/32">complete</p>
          <h1 className="mt-5 text-4xl leading-tight font-medium text-foreground sm:text-5xl">
            {detail.issue}
          </h1>
        </section>

        <section className="mx-auto mt-12 grid max-w-6xl gap-4 lg:grid-cols-2">
          <ArgumentPanel label="for" title="strongest case" argument={detail.pro} />
          <ArgumentPanel label="against" title="counter case" argument={detail.con} />
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen px-6 py-8 sm:px-8">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between">
        <Link href="/" className="text-[11px] uppercase tracking-[0.42em] text-foreground/35">
          autoreason
        </Link>
        <div className="text-right">
          <p className="text-[11px] tracking-[0.18em] text-foreground/28">{modeSummary(detail)}</p>
          <p className="mt-2 text-sm text-foreground/44">{statusLabel(detail)}</p>
        </div>
      </header>

      <section className="mx-auto mt-16 max-w-3xl text-center">
        <p className="text-[11px] uppercase tracking-[0.32em] text-foreground/32">
          {summaryText(detail)}
        </p>
        <h1 className="mt-5 text-4xl leading-tight font-medium text-foreground sm:text-5xl">
          {detail?.issue || "Reading the article and building the first pass."}
        </h1>
        <p className="mt-5 text-base leading-8 text-foreground/48">
          {detail?.sourceLabel ? `Source: ${detail.sourceLabel}` : "The report will appear here as soon as the run checkpoints."}
        </p>
      </section>

      <section className="mx-auto mt-14 max-w-3xl">
        <div className="rounded-[2rem] border border-foreground/10 bg-white p-6 shadow-[0_24px_80px_rgba(15,23,42,0.06)] sm:p-8">
          {deferredReport ? (
            <pre className="report-text whitespace-pre-wrap text-sm leading-7 text-foreground/68">
              {deferredReport}
            </pre>
          ) : (
            <div className="space-y-4 text-center text-foreground/38">
              <p className="text-sm uppercase tracking-[0.32em]">warming up</p>
              <p className="text-base">Connecting to the article and generating the opening case.</p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
