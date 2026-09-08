# Free-model testing before hosted inference

This operator-only probe sends the built-in `adeno-fictional-caregiver-v1` seed from `app/synthetic_probe_seed.py`. It is hand-authored fiction, visibly labeled `SYNTHETIC TEST RECORD — NOT A REAL PATIENT`, not an anonymized or modified real record. It includes fictional record/upload dates, an appointment, a family task, and a missing-information example. No database seeding is performed.

It does not load `.env`, application configuration, medical records, database contents, or arbitrary input files. It accepts no file, URL, prompt, or data-directory argument. Tests verify request construction without file/database access and rejection of arbitrary input flags. It does not enable AI in the hosted preview. Existing staging and managed-E2EE startup guards remain unchanged.

From the repository directory, after installing the documented local dependencies:

```sh
.venv/bin/python -m app.free_model_probe --list-free
.venv/bin/python -m app.free_model_probe --model PROVIDER/MODEL:free
```

Replace the model placeholder with an exact ID printed by the first command. The second command asks for the OpenRouter key in a hidden interactive terminal prompt. Never put the key in command arguments, chat, screenshots, source control, or a frontend setting. The probe does not save the key. Prefer a dedicated testing key with provider-side restrictions.

The probe checks the live public catalog for zero pricing, requires an explicit `:free` variant, sends zero maximum-price routing constraints, requests ZDR/no data collection, disables provider fallback and web search, and makes one bounded inference request without automatic retries. No matching endpoint means failure, not a downgrade to a paid or weaker-privacy endpoint. Free availability and rate limits vary.

A PASS verifies only a tiny Responses API structured-text exchange. It does not establish PDF/image compatibility, extraction accuracy, medical safety, E2EE, or production readiness. Check the actual charge in the OpenRouter activity dashboard. Do not submit real health information to this preview.

Do not simply add the key to Railway: the default application model may be paid, and staging intentionally rejects ordinary inference. Hosted AI requires a separately reviewed implementation of access, privacy, spending enforcement, and operation-specific compatibility tests. Any new database migration requires explicit approval.

References: [provider pricing limits](https://openrouter.ai/docs/guides/routing/provider-selection), [ZDR controls](https://openrouter.ai/docs/guides/features/zdr), [free-model limits](https://openrouter.ai/docs/faq).
