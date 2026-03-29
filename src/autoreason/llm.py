from __future__ import annotations

import concurrent.futures
import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from autoreason.config import ApiConfig


class LLMClient:
    def complete_json(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        purpose: str,
        temperature: float,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        raise NotImplementedError


@dataclass(frozen=True)
class CouncilMember:
    model: str
    client: LLMClient


def extract_json_object(text: str) -> dict[str, Any]:
    stripped = text.strip()
    candidates = [stripped]
    if stripped.startswith("```"):
        fenced = stripped.split("\n", 1)
        if len(fenced) == 2:
            payload = fenced[1]
            if payload.endswith("```"):
                payload = payload[:-3]
            candidates.append(payload.strip())

    decoder = json.JSONDecoder()
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

        for index, char in enumerate(candidate):
            if char != "{":
                continue
            try:
                parsed, _ = decoder.raw_decode(candidate[index:])
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                return parsed

    preview = stripped[:240].replace("\n", " ")
    raise ValueError(f"Model response did not contain a JSON object: {preview}")


def _message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        pieces: list[str] = []
        for item in content:
            if isinstance(item, str):
                pieces.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if isinstance(text, str):
                    pieces.append(text)
        return "\n".join(piece for piece in pieces if piece)
    return str(content)


class OpenAICompatibleClient(LLMClient):
    def __init__(self, config: ApiConfig):
        self.config = config

    def complete_json(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        purpose: str,
        temperature: float,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        payload = {
            "model": self.config.model,
            "temperature": temperature,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }
        response = self._post_json(payload, purpose=purpose)
        try:
            message = response["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ValueError(f"Unexpected model response shape for {purpose}: {response}") from exc

        parsed = extract_json_object(_message_text(message))
        usage = response.get("usage") if isinstance(response.get("usage"), dict) else {}
        return parsed, {"mode": "single", "model": self.config.model, "usage": usage}

    def _post_json(self, payload: dict[str, Any], *, purpose: str) -> dict[str, Any]:
        body = json.dumps(payload).encode("utf-8")
        url = f"{self.config.base_url.rstrip('/')}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }

        last_error: Exception | None = None
        for attempt in range(self.config.max_retries):
            request = urllib.request.Request(url=url, data=body, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(request, timeout=self.config.timeout_seconds) as response:
                    raw = response.read().decode("utf-8")
                return json.loads(raw)
            except urllib.error.HTTPError as exc:
                raw_error = exc.read().decode("utf-8", errors="replace")
                retryable = exc.code == 429 or 500 <= exc.code < 600
                last_error = RuntimeError(f"{purpose} failed with HTTP {exc.code}: {raw_error}")
                if not retryable or attempt == self.config.max_retries - 1:
                    raise last_error from exc
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt == self.config.max_retries - 1:
                    raise RuntimeError(f"{purpose} failed after retries: {exc}") from exc

            time.sleep(min(2 ** attempt, 8))

        raise RuntimeError(f"{purpose} failed: {last_error}")


def _normalized_ranking(labels: list[str], ranking: Any) -> list[str]:
    items = []
    if isinstance(ranking, list):
        items = [str(item).strip() for item in ranking]
    else:
        text = str(ranking or "").strip()
        if text:
            items = [text]

    ordered: list[str] = []
    seen: set[str] = set()
    for item in items:
        if item in labels and item not in seen:
            ordered.append(item)
            seen.add(item)
    for label in labels:
        if label not in seen:
            ordered.append(label)
    return ordered


def _aggregate_rankings(stage2_results: list[dict[str, Any]], labels: list[str]) -> list[dict[str, Any]]:
    positions: dict[str, list[int]] = {label: [] for label in labels}
    for result in stage2_results:
        ranking = _normalized_ranking(labels, result.get("ranking"))
        for index, label in enumerate(ranking, start=1):
            positions.setdefault(label, []).append(index)

    aggregate: list[dict[str, Any]] = []
    for label in labels:
        label_positions = positions.get(label) or []
        if not label_positions:
            continue
        average_rank = sum(label_positions) / len(label_positions)
        aggregate.append(
            {
                "candidate": label,
                "average_rank": round(average_rank, 2),
                "rankings_count": len(label_positions),
            }
        )

    aggregate.sort(key=lambda item: (item["average_rank"], item["candidate"]))
    return aggregate


class CouncilClient(LLMClient):
    def __init__(
        self,
        members: list[CouncilMember],
        chairman: CouncilMember,
        *,
        max_workers: int = 4,
    ):
        if not members:
            raise ValueError("CouncilClient requires at least one council member.")
        self.members = members
        self.chairman = chairman
        self.max_workers = max(1, max_workers)

    def complete_json(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        purpose: str,
        temperature: float,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        stage1_results, stage1_errors = self._collect_stage1(
            system_prompt,
            user_prompt,
            purpose=purpose,
            temperature=temperature,
        )
        if not stage1_results:
            error_preview = "; ".join(stage1_errors) or "all council members failed"
            raise RuntimeError(f"Council failed for {purpose}: {error_preview}")

        metadata: dict[str, Any] = {
            "mode": "council",
            "purpose": purpose,
            "members": [member.model for member in self.members],
            "chairman_model": self.chairman.model,
            "stage1": [
                {
                    "model": result["model"],
                    "metadata": result["metadata"],
                }
                for result in stage1_results
            ],
            "errors": stage1_errors,
        }

        if len(stage1_results) == 1:
            metadata["degraded"] = True
            metadata["degraded_reason"] = "Only one council member produced a valid JSON response."
            return stage1_results[0]["response"], metadata

        labels = [f"Candidate {chr(65 + index)}" for index in range(len(stage1_results))]
        stage2_results, stage2_errors = self._collect_rankings(
            system_prompt,
            user_prompt,
            purpose=purpose,
            temperature=temperature,
            stage1_results=stage1_results,
            labels=labels,
        )
        aggregate_rankings = _aggregate_rankings(stage2_results, labels)
        metadata["stage2"] = stage2_results
        metadata["stage2_errors"] = stage2_errors
        metadata["aggregate_rankings"] = aggregate_rankings
        metadata["candidate_map"] = {
            label: stage1_results[index]["model"] for index, label in enumerate(labels)
        }

        synthesis_prompt = self._build_synthesis_prompt(
            system_prompt,
            user_prompt,
            stage1_results=stage1_results,
            stage2_results=stage2_results,
            aggregate_rankings=aggregate_rankings,
            labels=labels,
        )
        final_response, chairman_metadata = self.chairman.client.complete_json(
            self._synthesis_system_prompt(system_prompt),
            synthesis_prompt,
            purpose=f"council-synthesize:{purpose}",
            temperature=temperature,
        )
        metadata["chairman"] = chairman_metadata
        return final_response, metadata

    def _collect_stage1(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        purpose: str,
        temperature: float,
    ) -> tuple[list[dict[str, Any]], list[str]]:
        results: list[dict[str, Any]] = []
        errors: list[str] = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(self.max_workers, len(self.members))) as executor:
            future_map = {
                executor.submit(
                    member.client.complete_json,
                    system_prompt,
                    user_prompt,
                    purpose=purpose,
                    temperature=temperature,
                ): member
                for member in self.members
            }
            for future in concurrent.futures.as_completed(future_map):
                member = future_map[future]
                try:
                    response, metadata = future.result()
                except Exception as exc:
                    errors.append(f"{member.model}: {exc}")
                    continue
                results.append({"model": member.model, "response": response, "metadata": metadata})

        results.sort(key=lambda item: item["model"])
        return results, errors

    def _collect_rankings(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        purpose: str,
        temperature: float,
        stage1_results: list[dict[str, Any]],
        labels: list[str],
    ) -> tuple[list[dict[str, Any]], list[str]]:
        ranking_system_prompt = self._ranking_system_prompt()
        ranking_user_prompt = self._build_ranking_prompt(
            system_prompt,
            user_prompt,
            stage1_results=stage1_results,
            labels=labels,
        )

        rankings: list[dict[str, Any]] = []
        errors: list[str] = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(self.max_workers, len(self.members))) as executor:
            future_map = {
                executor.submit(
                    member.client.complete_json,
                    ranking_system_prompt,
                    ranking_user_prompt,
                    purpose=f"council-rank:{purpose}",
                    temperature=temperature,
                ): member
                for member in self.members
            }
            for future in concurrent.futures.as_completed(future_map):
                member = future_map[future]
                try:
                    response, metadata = future.result()
                except Exception as exc:
                    errors.append(f"{member.model}: {exc}")
                    continue

                ranking = _normalized_ranking(labels, response.get("ranking"))
                evaluations = response.get("evaluations")
                if not isinstance(evaluations, list):
                    evaluations = []
                rankings.append(
                    {
                        "model": member.model,
                        "ranking": ranking,
                        "best_candidate": ranking[0] if ranking else "",
                        "evaluations": evaluations,
                        "reasoning_summary": str(response.get("reasoning_summary") or "").strip(),
                        "metadata": metadata,
                    }
                )

        rankings.sort(key=lambda item: item["model"])
        return rankings, errors

    @staticmethod
    def _ranking_system_prompt() -> str:
        return (
            "You are part of an LLM council evaluating anonymized candidate JSON answers.\n"
            "Return valid JSON only.\n"
            "Judge candidates on instruction-following, grounding to the task, internal consistency, "
            "usefulness, and calibrated uncertainty.\n"
            "Do not infer authorship from style.\n"
        )

    @staticmethod
    def _synthesis_system_prompt(base_system_prompt: str) -> str:
        return (
            f"{base_system_prompt}\n\n"
            "You are now acting as the chairman of an LLM council.\n"
            "Synthesize the strongest final answer from the candidate outputs and peer rankings.\n"
            "Return the single best JSON answer for the original task.\n"
        )

    @staticmethod
    def _build_ranking_prompt(
        system_prompt: str,
        user_prompt: str,
        *,
        stage1_results: list[dict[str, Any]],
        labels: list[str],
    ) -> str:
        candidates = []
        for label, result in zip(labels, stage1_results):
            pretty_json = json.dumps(result["response"], indent=2, ensure_ascii=True, sort_keys=True)
            candidates.append(f"{label}:\n{pretty_json}")

        return (
            "Original task the candidates were trying to solve:\n"
            f"SYSTEM PROMPT:\n{system_prompt}\n\n"
            f"USER PROMPT:\n{user_prompt}\n\n"
            "Anonymized candidate JSON outputs:\n"
            f"{chr(10).join(candidates)}\n\n"
            "Return a JSON object with this exact shape:\n"
            "{\n"
            '  "evaluations": [\n'
            '    {\n'
            '      "candidate": "Candidate A",\n'
            '      "strengths": ["..."],\n'
            '      "weaknesses": ["..."]\n'
            "    }\n"
            "  ],\n"
            '  "ranking": ["Candidate A", "Candidate B"],\n'
            '  "reasoning_summary": "short explanation of the overall ranking"\n'
            "}\n"
            "Include every candidate exactly once in ranking, best to worst."
        )

    @staticmethod
    def _build_synthesis_prompt(
        system_prompt: str,
        user_prompt: str,
        *,
        stage1_results: list[dict[str, Any]],
        stage2_results: list[dict[str, Any]],
        aggregate_rankings: list[dict[str, Any]],
        labels: list[str],
    ) -> str:
        candidate_sections = []
        for label, result in zip(labels, stage1_results):
            candidate_sections.append(
                f"{label} (source model: {result['model']}):\n"
                f"{json.dumps(result['response'], indent=2, ensure_ascii=True, sort_keys=True)}"
            )

        ranking_sections = []
        for result in stage2_results:
            ranking_sections.append(
                f"Ranker model: {result['model']}\n"
                f"Ranking: {json.dumps(result['ranking'], ensure_ascii=True)}\n"
                f"Summary: {result['reasoning_summary']}"
            )

        aggregate_lines = [
            f"{entry['candidate']}: average rank {entry['average_rank']} across {entry['rankings_count']} rankings"
            for entry in aggregate_rankings
        ]

        return (
            "Original task to solve:\n"
            f"SYSTEM PROMPT:\n{system_prompt}\n\n"
            f"USER PROMPT:\n{user_prompt}\n\n"
            "Stage 1 candidate outputs:\n"
            f"{chr(10).join(candidate_sections)}\n\n"
            "Stage 2 peer rankings:\n"
            f"{chr(10).join(ranking_sections) if ranking_sections else 'No rankings available.'}\n\n"
            "Aggregate ranking summary:\n"
            f"{chr(10).join(aggregate_lines) if aggregate_lines else 'No aggregate ranking available.'}\n\n"
            "Return the best final JSON answer for the original task. Keep what multiple models agree on, "
            "repair weaknesses exposed by peer review, and preserve uncertainty where the evidence is thin."
        )
