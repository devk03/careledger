import pytest

from app.ai.provider import OPENROUTER_BASE_URL, AIProvider, resolve_provider


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
