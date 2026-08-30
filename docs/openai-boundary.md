# OpenAI extraction boundary

CareLedger uses the server-side Responses API only for caregiver-requested extraction. The browser never receives the API key.

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

The default `gpt-5.4-mini-2026-03-17` snapshot supports image input, the Responses API, and Structured Outputs. Operators can change `OPENAI_MODEL`.

`store: false` prevents later API retrieval of the response, but it does not by itself provide Zero Data Retention, a Business Associate Agreement, or HIPAA compliance. Review the current official documentation before processing protected health information:

- [Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [File inputs](https://developers.openai.com/api/docs/guides/file-inputs)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Data controls](https://developers.openai.com/api/docs/guides/your-data)
- [GPT-5.4 Mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
