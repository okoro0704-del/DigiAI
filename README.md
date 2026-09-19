# Digi AI

Digi AI is the Digiconomy intelligence primitive.

External models are providers consumed by Digi AI. They are not Digi AI.

Phase 1 is read-only with respect to Digiconomy domain state: answer, reason, retrieve public DigiPedia and DigiNews, meter usage, and propose OS Shell objective candidates. Digi AI does not publish, send, pay, or execute tools.

## Identity

Trust ID remains the human identity authority. Digi AI does not create users.

Callers:

1. First-party UI: Trust ID session or access token.
2. Applications: `x-digi-ai-caller` + `x-digi-ai-caller-key`, plus a forwarded Trust ID actor proof.

Client headers such as `x-trust-id`, `x-user-id`, `x-is-owner`, and `?owner=true` are rejected.

## Retention

Stored:

- usage metadata (provider, model, token counts when supplied, latency, actor/caller/entity references)
- request receipts (operation, sources accessed, result status)

Not stored:

- provider API keys
- full prompts or full generated answers
- DigiPedia entries
- DigiNews publications

## Digi Twin briefing

`POST /v1/twin/brief` is a structured “What’s popping?” capability. Digi Twin is a human-facing experience powered by Digi AI, not a second backend.

An authorized application (currently mybrandOS) must resolve the Digital Life from the Trust ID session and supply owner-authorized activity. Digi AI then reads public DigiPedia and DigiNews by that authorized slug. Factual sections are returned even when model inference is unavailable. Interpretations are labeled separately and are never treated as canonical knowledge.

## Health

`GET /health` reports service liveness and whether a provider is configured. An unbound provider does not mark the service down.
