from collections.abc import Mapping
from typing import Any, Protocol

from openai import OpenAI

from app.ai.request import assert_openrouter_patient_request


class ResponsesTransport(Protocol):
    def create(self, request: Mapping[str, Any]) -> object: ...


class OpenAIResponsesTransport:
    def __init__(self, api_key: str, *, base_url: str | None = None) -> None:
        self._client = OpenAI(api_key=api_key, base_url=base_url)

    def create(self, request: Mapping[str, Any]) -> object:
        return self._client.responses.create(**dict(request))


class OpenRouterPatientDataTransport:
    def __init__(self, delegate: ResponsesTransport) -> None:
        self._delegate = delegate

    def create(self, request: Mapping[str, Any]) -> object:
        mutable_request = dict(request)
        assert_openrouter_patient_request(mutable_request)
        return self._delegate.create(mutable_request)
