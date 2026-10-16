# Background compaction

A Pi extension that asynchronously summarizes older user-turn spans while leaving Pi's native compaction as the fallback.

- `src/`: runtime modules copied into Pi's extension directory.
- `test/`: unit, prompt-parity, and isolated installer/load tests.
- `validation/`: effectiveness report, aggregate campaign measurements, and test results.

## Install

From this directory:

```sh
./install.sh
```

The script installs runtime files into `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/background-compaction`, updates that agent directory's `settings.json`, and saves a rollback copy under `backups/background-compaction/`. Pi's `PI_CODING_AGENT_DIR` is the supported agent-directory override; it defaults to `~/.pi/agent`.

To uninstall while preserving the installed copy in a backup:

```sh
./install.sh --uninstall
```

## Production behavior

- Allowed model: `openai-codex/gpt-6-luna` only; other models use Pi native compaction.
- Trigger: 50% of the advertised context window.
- Retention: newest 20% of user turns; at most 80 turns per summary batch.
- Summary request: Pi's native system prompt, initial/update prompt templates, serializer, and file-list format.
- Output budget: 80% of Pi's default 16,384-token reserve; summary timeout: 30 seconds.
- A standard-compaction event cancels/discards pending background work and proceeds through Pi's native path.

While a summary request is running in Pi's interactive TUI, an animated footer status shows the turn range and elapsed seconds. It clears as soon as summarization completes or is cancelled; there is no lingering ready/idle indicator. In non-TUI modes, the existing start notification is used instead. Run `/bgcompact` to manually start the same background summarizer below the automatic 50% threshold. It rebuilds the current conversation projection from Pi's session manager, so it also works immediately after resuming a session; it only starts while Pi is idle and the latest projected message is an assistant reply. The command always notifies when work starts and when a summary is ready; results apply at a later safe turn boundary and remain restricted to the configured model allowlist. Diagnostic commands (`/bgcompact-status`, `/bgcompact-probe`, `/bgcompact-selftest`) are registered only when Pi starts with `PI_BGCOMPACT_DEBUG=1`, e.g. `PI_BGCOMPACT_DEBUG=1 pi`. The provider probe is restricted to the configured model allowlist.

## Validation

From the repository root:

```sh
npm test
```

Tests cover prompt parity with the installed Pi version, automatic and manual starts, threshold/planning/state transitions, cancellation/fallback, model allowlisting, debug-only command visibility, and an isolated install/load/uninstall smoke test. The smoke test makes no model requests. Exploratory effectiveness measurements and summarized generated-app test results are in [`validation/`](validation/). Raw per-run state, notification logs, manifests, and machine-local paths are intentionally kept out of the repository.
