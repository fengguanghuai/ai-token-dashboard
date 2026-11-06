# API pricing verification — 2026-11-06

This is a **targeted official-source correction**, not certification of every entry in the bundled catalogs (4,975 LiteLLM and 345 OpenRouter entries). No model IDs were added or removed. Prices below are USD per **1,000,000 tokens**; the JSON stores USD per token (divide by 1,000,000). Subscription allowances, taxes, regional uplifts and negotiated discounts are not API list prices.

## Verified changes

- [Mistral Large 4 model card](https://docs.mistral.ai/models/mistral-large-4-0), public preview v26.10, 1M context: input **0.68 → 0.70**, output **2.09 → 2.10**, cached input **0.068 → 0.070**. Updated existing `mistral/mistral-large-4` and `mistral/mistral-large-4-0` entries. The `mistralai/mistral-large-4-0` fallback already had cache read 0.070; only its input/output changed. The source does not specify a cache-write rate; the existing absent/null value is retained, not claimed to be a verified free write.
- [OpenAI pricing](https://developers.openai.com/api/docs/pricing) ([complete Markdown tables](https://developers.openai.com/api/docs/pricing.md)): 17 existing standard OpenAI fallback entries contained half-price rates. Corrected them to the supplier's **Standard** rates below, consistent with the primary catalog. Explicit `:batch` entries remain unchanged. The fallback is used for supplier cost estimation; this is not a claim about every OpenRouter routing offer.

| Existing OpenAI fallback model | Input | Output | Cache read | Cache write (30m) |
| --- | ---: | ---: | ---: | ---: |
| gpt-6-astra | 10 | 50 | 1 | 12.5 |
| gpt-6.1-sol | 2 | 10 | 0.1 | 2.5 |
| gpt-6-sol | 2 | 10 | 0.2 | 2.5 |
| gpt-6-luna | 0.1 | 0.5 | 0.01 | 0.125 |
| gpt-5.6-sol | 4 | 20 | 0.4 | 5 |
| gpt-5.6-terra | 2 | 12 | 0.2 | 2.5 |
| gpt-5.6-luna | 0.2 | 1.2 | 0.02 | 0.25 |
| gpt-5.5 | 5 | 30 | 0.5 | — |
| gpt-5.5-pro | 30 | 180 | — | — |
| gpt-5.4 | 2.5 | 15 | 0.25 | — |
| gpt-5.4-pro | 30 | 180 | — | — |
| gpt-5.4-mini | 0.75 | 4.5 | 0.075 | — |
| gpt-5.4-nano | 0.2 | 1.25 | 0.02 | — |
| gpt-5.2 | 1.75 | 14 | 0.175 | — |
| gpt-5.1 | 1.25 | 10 | 0.125 | — |
| gpt-5-mini | 0.25 | 2 | 0.025 | — |
| gpt-5-nano | 0.05 | 0.4 | 0.005 | — |

`—` means no numeric rate established by this table, **not** a new zero. Existing fields are preserved. These base rates were already correct in LiteLLM. For GPT-6 Astra and GPT-5.4/5.5/5.6 variants above that have a published long-context tier, the fallback now also carries the existing calculator's supported **>272,000 prompt-token** rates: input/cache read/30m cache write ×2, output ×1.5. Exactly 272,000 remains short context. GPT-5.4 mini/nano do not acquire a long-context tier.

## Other official sources checked / retained values

All access attempts below were made on **2026-11-06**. Unconfirmed entries retain their original values; a reachable page alone does not validate every model/version/region in the catalog.

| Supplier / official source | Verification outcome and retention reason |
| --- | --- |
| [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing.md) | Current Flash is V4.1-Flash-1017; `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are accepted legacy aliases. Peak input/output/cache read 0.30/1.20/0.006, Pro-0813 1.32/3.96/0.044 match the direct entries. **Off-peak is half price**, not represented by the current calculator; retained peak estimates. Historical dated versions are not silently remapped. |
| [Z.AI](https://docs.z.ai/guides/overview/pricing) | GLM-5.3 and 5.1/5.2: 1.4/4.4/0.26; GLM-5.3-Flash: 0.15/0.50/0.03; GLM-5: 1/3.2/0.2 match direct entries. Storage is explicitly *limited-time free*, not a permanent subscription allowance. Other versions retained. |
| [xAI](https://docs.x.ai/developers/models/grok-4.7) | Grok-4.7 base input/output 2/6 matches. No blanket replacement of older Grok aliases or other tier/cache fields from the overview. |
| [Google](https://aistudio.google.com/docs/pricing) | Public paid/free, modality, batch and storage pricing is accessible. No blanket replacement of model/region/context-specific rows or conversion of hourly storage into token-write rates. Retained unconfirmed entries. |
| [Alibaba Cloud](https://www.alibabacloud.com/help/en/model-studio/model-pricing) | Reachable; deployment-region, context and modality variants are not interchangeable. No model/version/region mapping sufficiently established for changes here; retained values. |
| [MiniMax](https://platform.minimax.io/docs/guides/pricing-paygo) | Reachable; no exact existing-entry change established here. Retained values. |
| [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) | HTTP 403 for HTML and Markdown; legacy docs URL also returned 403. Retained all prices, without substituting reseller or subscription rates. |
| [Moonshot](https://platform.moonshot.ai/docs/pricing/chat) | HTTP 403 for HTML, Markdown and overview alternative. Retained all prices. |
| [Cursor](https://cursor.com/docs/models-and-pricing) | Current page does not establish the old Composer 1/1.5/2 and GPT-5.3/Spark fallback prices. Retained overrides; GPT-5.3-Codex itself is confirmed by OpenAI at 1.75/14/0.175. Did not equate newer Composer versions or plan credits to these older models. |

All other catalog entries, including third-party hosting, retired models, media/tool charges and unverified batch variants, are unchanged and **not newly verified**. The broad catalog is upstream-derived, not an official-source audit. `fetchedAt` remains the original snapshot retrieval time (2026-10-19); advancing it would falsely imply a full refresh. This document dates the targeted corrections. A future explicit `pricing:update` can overwrite them with upstream data and should be rechecked.

## Calculation contract and limitations

The unchanged calculator accepts separate uncached input, output, cache read, cache write and reasoning token counts. Reasoning is charged as output; missing cache rates currently contribute zero. Normal lookup tries provider-qualified/bare aliases, primary and fallback catalogs, then Cursor overrides/fuzzy aliases. A fallback with cache prices can win over a primary entry without them. Tests cover both combined and fallback-only lookup, so a correct primary entry cannot conceal a stale fallback.

These are estimates, not invoice reconciliation. No collector, public interface, UI, historical database or stored cost was changed. In particular:

- Cache writes here use the existing short-retention rate. OpenAI now publishes a separate 12h write price (e.g. Astra 25/M versus 12.5/M for 30m); callers provide no retention duration.
- DeepSeek peak hours are Monday–Friday 01:00–04:00 and 06:00–10:00 UTC, excluding Chinese public holidays; all other times are off-peak. The cost API receives neither request time nor a holiday calendar. Retaining peak rates can overestimate off-peak cost by 2×.
- GPT-6 Sol/Luna/6.1 Sol and generic Gemini/Claude long-context calculations retain their pre-existing behavior; this change does not assert correct whole-request long-context billing for those families. Aggregated daily callers explicitly disable request tiers. OpenAI's added fallback tiers only cover families already supported by the whole-request branch.
- The undated `mistral-large-4` alias is present only in the primary catalog. If that catalog is unavailable, existing suffix stripping can resolve it to the older `mistral-large`; use the existing `mistral-large-4-0` ID for fallback-only lookup. No new alias or lookup-policy change is included.
- There is no general service-tier, cache-duration or hourly-storage selector. Correct billing across these dimensions requires deciding defaults for logs missing that information and passing new metadata from collectors through persisted records to calculation. That is a separate scope decision, not something to infer from a price-table refresh.

## Reproducible checks

`node --test test/pricing-catalog.test.mjs` checks USD/million conversion for every changed OpenAI model, Mistral aliases and cache savings, batch preservation, and Astra's prompt-length boundary including cache writes and reasoning. A request with one million each of Mistral input/output/cache-read tokens costs **$2.87**; one million cache-read tokens saves **$0.63**. Full repository checks are recorded in the PR. No paid model request or user credentials are needed.
