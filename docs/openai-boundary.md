# Caregiver-funded AI extraction boundary

CareLedger uses a server-side Responses-compatible API only for caregiver-requested extraction. The browser never receives the API key. With no key, record intake and local organization continue without AI.

Provider selection is explicit and server-side:

- `OPENROUTER_API_KEY`: use OpenRouter's Responses endpoint and the caregiver's account.
- `OPENAI_API_KEY`: use OpenAI directly and the caregiver's account.
- `CUSTOM_AI_API_KEY` plus `CUSTOM_AI_BASE_URL`: use an explicitly configured Responses-compatible HTTPS gateway.

No project-owned fallback key exists, so the open-source maintainer does not inherit inference costs.

Every patient-record request is built with:

- `store: false`
- `background: false`
- `stream: false`
- `tools: []` and `tool_choice: "none"`
- `parallel_tool_calls: false`
- `truncation: "disabled"`
- an opaque HMAC-derived `safety_identifier`
- inline Base64 PDF/image content and a generic digest-derived filename
- a strict JSON Schema response format

Document text is untrusted evidence, never instructions. Local validation rejects the entire batch for incomplete responses, refusals, tool output, schema deviations, duplicate references, missing/out-of-batch pages, quote mismatches, or invalid bounding boxes. The model cannot create authoritative provenance: CareLedger stamps prompt/schema/request/model/source/page hashes locally and keeps every result in `proposed` review state.

The model is set with `AI_MODEL`. Operators must choose a model that supports the Responses request shape, PDF/image input, and strict structured output. OpenRouter documents `/api/v1/responses`, model capabilities, image/PDF input, and caregiver-account rate limits. Ollama documents a partial Responses-compatible endpoint, but its supported request fields differ; CareLedger does not silently route the strict hosted request through Ollama until a dedicated adapter passes the same citation and schema tests.

`store: false` prevents later API retrieval of the response, but it does not by itself provide Zero Data Retention, a Business Associate Agreement, or HIPAA compliance. Review the current official documentation before processing protected health information:

- [OpenRouter Responses API](https://openrouter.ai/docs/api/api-reference/responses/create-responses)
- [OpenRouter model capabilities](https://openrouter.ai/docs/guides/overview/models)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [File inputs](https://developers.openai.com/api/docs/guides/file-inputs)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Data controls](https://developers.openai.com/api/docs/guides/your-data)
- [GPT-5.4 Mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
