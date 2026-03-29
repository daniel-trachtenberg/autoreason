from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class ApiConfig:
    base_url: str
    api_key: str
    model: str
    timeout_seconds: float = 120.0
    max_retries: int = 5


def load_api_config_from_env() -> ApiConfig:
    api_key = os.environ.get("AUTOREASON_API_KEY", "").strip()
    model = os.environ.get("AUTOREASON_MODEL", "").strip()
    base_url = os.environ.get("AUTOREASON_BASE_URL", "https://api.openai.com/v1").strip()
    timeout_seconds = float(os.environ.get("AUTOREASON_TIMEOUT_SECONDS", "120"))
    max_retries = int(os.environ.get("AUTOREASON_MAX_RETRIES", "5"))

    missing = []
    if not api_key:
        missing.append("AUTOREASON_API_KEY")
    if not model:
        missing.append("AUTOREASON_MODEL")
    if missing:
        joined = ", ".join(missing)
        raise ValueError(f"Missing required environment variable(s): {joined}")

    return ApiConfig(
        base_url=base_url,
        api_key=api_key,
        model=model,
        timeout_seconds=timeout_seconds,
        max_retries=max_retries,
    )
