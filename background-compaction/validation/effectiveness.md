# Effectiveness record: GPT-6 Luna compaction comparison

**Result:** three paired campaign slots were attempted. Two are clean background-vs-native pairs; the third background arm invoked Pi's native fallback after an additional background summary was preempted, so it is reported separately and excluded from the strict averages.

## Conditions

- Model: `openai-codex/gpt-6-luna`.
- Identical three-phase synthetic storefront task in fresh work directories; alternating run order.
- Test-only context override: 24,576 tokens, max output 8,192, reserve 4,096, keep-recent 2,000. The model catalog advertises 272K context / 128K max output. Results should not be extrapolated directly to the full advertised context.
- Background summarization system, initial, and update prompts were checked byte-for-byte against the installed Pi compaction implementation. The parity test is included.
- Prompt-token totals are per-request aggregates and include cache-read tokens; `cacheReadTokens` is a subset, not additional tokens. Cost is Pi's model-catalog estimate, not an invoice.

## Clean paired runs

| Pair | Mode | Wall time | Total tokens | Summary tokens | App tests |
|---|---|---:|---:|---:|---:|
| 1 | Background | 133.6 s | 361,983 | 9,953 | 4/4 pass |
| 1 | Pi native | 168.1 s | 482,967 | 15,680 | 4/4 pass |
| 2 | Background | 148.4 s | 461,755 | 9,284 | 4/4 pass |
| 2 | Pi native | 258.3 s | 488,928 | 13,507 | 5/5 pass |

Mean over these **two clean pairs**:

| Metric | Background | Pi native | Observed difference |
|---|---:|---:|---:|
| Wall time | 141.0 s | 213.2 s | 33.9% lower |
| Total tokens | 411,869 | 485,948 | 15.2% lower |
| Summary tokens | 9,619 | 14,594 | 34.1% lower |
| Pi-estimated cost | $0.01736 | $0.01861 | 6.7% lower |

In both clean background runs, the logs show two main assistant messages overlapping the background-summary pending interval; the native compaction runs had no main messages during their synchronous compact interval.

## Pair 3: hybrid/fallback observation

The background arm (campaign `ec-luna-2026-10-16T06-53-54.950Z-8aebd7`) applied one background summary, then started another. Pi's standard compaction preempted that pending summary twice. Its 292.8 s / 480,254-token totals therefore include background plus native compaction work and are not a pure background-mode result. The paired native arm also compacted twice. Both runs completed all three task phases and their app tests passed 4/4. The notifications record the yields explicitly.

## Interpretation and limits

- The measurements are promising, but **n=2 clean pairs is too small for a general performance claim**; model output, request count, cache behavior, and task edits varied between runs.
- The lower token/time totals are observations, not proof that the compaction algorithm alone caused the difference.
- The third pair verifies the native fallback path works, but also shows that background compaction can yield before a later summary is ready.
- The run harness initially had two test-discovery/report-format assumptions. The affected generated tests were run directly and passed; the assumptions were corrected before the final pair.

## Artifacts

- Repeated aggregate JSON: [`comparison-gpt-6-luna-repeated.json`](comparison-gpt-6-luna-repeated.json)
- Actual generated-app test counts: [`app-test-results.json`](app-test-results.json)
- Repository test result: [`repository-tests.txt`](repository-tests.txt)

Raw per-run state, notification logs, manifests, and machine-local temporary paths are intentionally excluded; the summarized records above retain the results and their limitations.
