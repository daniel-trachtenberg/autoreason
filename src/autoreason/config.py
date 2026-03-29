from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class ApiConfig:
    base_url: str
    api_key: str
    model: str = ""
    timeout_seconds: float = 120.0
    max_retries: int = 5

    def with_model(self, model: str) -> "ApiConfig":
        return ApiConfig(
            base_url=self.base_url,
            api_key=self.api_key,
            model=model,
            timeout_seconds=self.timeout_seconds,
            max_retries=self.max_retries,
        )


def load_api_config_from_env() -> ApiConfig:
    api_key = os.environ.get("AUTOREASON_API_KEY", "").strip()
    model = os.environ.get("AUTOREASON_MODEL", "").strip()
    base_url = os.environ.get("AUTOREASON_BASE_URL", "https://api.openai.com/v1").strip()
    timeout_seconds = float(os.environ.get("AUTOREASON_TIMEOUT_SECONDS", "120"))
    max_retries = int(os.environ.get("AUTOREASON_MAX_RETRIES", "5"))

    if not api_key:
        raise ValueError("Missing required environment variable: AUTOREASON_API_KEY")

    return ApiConfig(
        base_url=base_url,
        api_key=api_key,
        model=model,
        timeout_seconds=timeout_seconds,
        max_retries=max_retries,
    )
