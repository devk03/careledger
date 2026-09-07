import pytest

from app.ai.provider import OPENROUTER_BASE_URL, AIProvider, resolve_provider
from app.config import Settings


def test_auto_provider_defaults_to_disabled_without_a_caregiver_key() -> None:
    runtime = resolve_provider(
        provider="auto",
        model="synthetic-model",
        openrouter_api_key=None,
        openai_api_key=None,
        custom_api_key=None,
        custom_base_url=None,
    )

    assert runtime.provider == AIProvider.DISABLED
    assert runtime.enabled is False
    assert runtime.external_transfer_required is False


def test_openrouter_key_selects_caregiver_funded_gateway() -> None:
    runtime = resolve_provider(
        provider="auto",
        model="synthetic/model",
        openrouter_api_key="synthetic-openrouter-key",  # noqa: S106
        openai_api_key=None,
        custom_api_key=None,
        custom_base_url=None,
    )

    assert runtime.provider == AIProvider.OPENROUTER
    assert runtime.model == "synthetic/model"
    assert runtime.base_url == OPENROUTER_BASE_URL
    assert runtime.external_transfer_required is True


def test_custom_gateway_rejects_cleartext_nonlocal_url() -> None:
    with pytest.raises(ValueError, match="HTTPS"):
        resolve_provider(
            provider="custom_responses",
            model="synthetic-model",
            openrouter_api_key=None,
            openai_api_key=None,
            custom_api_key="synthetic-custom-key",  # noqa: S106
            custom_base_url="http://gateway.example.test/v1",
        )


def test_custom_gateway_cannot_disguise_openrouter_and_bypass_privacy_policy() -> None:
    with pytest.raises(ValueError, match="privacy-enforced"):
        resolve_provider(
            provider="custom_responses",
            model="synthetic-model",
            openrouter_api_key=None,
            openai_api_key=None,
            custom_api_key="synthetic-custom-key",  # noqa: S106
            custom_base_url="https://openrouter.ai/api/v1",
        )


def test_direct_openai_strips_the_openrouter_provider_prefix() -> None:
    runtime = resolve_provider(
        provider="auto",
        model="openai/synthetic-model",
        openrouter_api_key=None,
        openai_api_key="synthetic-openai-key",  # noqa: S106
        custom_api_key=None,
        custom_base_url=None,
    )

    assert runtime.provider == AIProvider.OPENAI
    assert runtime.model == "synthetic-model"


def test_per_user_oauth_mode_cannot_fall_back_to_a_deployment_key() -> None:
    runtime = Settings(
        ai_credential_mode="per_user_oauth",
        openrouter_api_key=None,
        openai_api_key=None,
        custom_ai_api_key=None,
        custom_ai_base_url=None,
    ).ai_runtime()
    assert runtime.provider == AIProvider.DISABLED

    with pytest.raises(ValueError, match="forbids deployment-wide"):
        Settings(
            ai_credential_mode="per_user_oauth",
            openrouter_api_key="synthetic-deployment-key",  # noqa: S106
        ).ai_runtime()
