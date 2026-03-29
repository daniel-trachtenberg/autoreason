from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
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
        return parsed, usage

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
