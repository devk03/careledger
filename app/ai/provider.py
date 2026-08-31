from dataclasses import dataclass
from enum import StrEnum

from app.ai.service import ExtractionService
from app.ai.transport import OpenAIResponsesTransport

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


class AIProvider(StrEnum):
    DISABLED = "disabled"
    OPENROUTER = "openrouter"
    OPENAI = "openai"
    CUSTOM_RESPONSES = "custom_responses"


@dataclass(frozen=True)
class AIProviderRuntime:
    provider: AIProvider
    model: str | None
    api_key: str | None
    base_url: str | None

    @property
    def enabled(self) -> bool:
        return self.provider != AIProvider.DISABLED

    @property
    def external_transfer_required(self) -> bool:
        return self.enabled

    def extraction_service(self) -> ExtractionService:
        if not self.enabled or not self.api_key or not self.model:
            raise ValueError("AI provider is not configured")
        return ExtractionService(
            OpenAIResponsesTransport(self.api_key, base_url=self.base_url),
            model=self.model,
        )


def resolve_provider(
    *,
    provider: str,
    model: str,
    openrouter_api_key: str | None,
    openai_api_key: str | None,
    custom_api_key: str | None,
    custom_base_url: str | None,
) -> AIProviderRuntime:
    selected = provider.strip().lower()
    if selected == "auto":
        if openrouter_api_key:
            selected = AIProvider.OPENROUTER.value
        elif openai_api_key:
            selected = AIProvider.OPENAI.value
        else:
            selected = AIProvider.DISABLED.value
    try:
        kind = AIProvider(selected)
    except ValueError as error:
        raise ValueError("unsupported AI provider") from error
    if kind == AIProvider.DISABLED:
        return AIProviderRuntime(kind, None, None, None)
    if not model.strip():
        raise ValueError("AI model is required")
    if kind == AIProvider.OPENROUTER:
        if not openrouter_api_key:
            raise ValueError("OPENROUTER_API_KEY is required")
        return AIProviderRuntime(kind, model.strip(), openrouter_api_key, OPENROUTER_BASE_URL)
    if kind == AIProvider.OPENAI:
        if not openai_api_key:
            raise ValueError("OPENAI_API_KEY is required")
        direct_model = model.strip()
        if direct_model.startswith("openai/"):
            direct_model = direct_model.removeprefix("openai/")
        return AIProviderRuntime(kind, direct_model, openai_api_key, None)
    if not custom_api_key or not custom_base_url:
        raise ValueError("CUSTOM_AI_API_KEY and CUSTOM_AI_BASE_URL are required")
    if not custom_base_url.startswith(("https://", "http://localhost", "http://127.0.0.1")):
        raise ValueError("custom AI base URL must use HTTPS unless it is local")
    return AIProviderRuntime(kind, model.strip(), custom_api_key, custom_base_url.rstrip("/"))
