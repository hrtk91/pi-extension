# Goal panel (prototype)

A session-scoped goal panel with a small top-right ○/◉ toggle and a tall, narrow sidebar layout. Its extensible tab/slot registry is demonstrated by the Goal and sample Usage Stats slots. The worker receives goal reminders and can invoke an independent read-only GoalChecker tool; only evidence-backed checker passes automatically complete criteria. The extension does not launch a handoff agent.

## Try it without installing globally

From the repository root:

```sh
pi --no-extensions --extension ./goal/src/extension.mjs --no-session --no-mcp --offline
```

Click the top-right ○/◉ icon to toggle the panel (`○` closed, `◉` open); the icon stays fixed while the panel floats below it by default. Click the icon again to close. The top tab strip can be dragged to move the panel; drag its frame edges to resize one dimension, or a corner to resize both. The panel stays within terminal bounds, and its position and size are retained while Pi is running. Click tabs or the `‹` / `›` arrows to switch slots. Scroll the body with the mouse wheel or scrollbar. The panel is mouse-only; keyboard input stays in the main editor. You can still type `/goal` there to toggle the panel.

## Commands

- `/goal set <goal>` (or `/goal <goal>`) — set/replace the current goal
- `/goal criterion <condition>` — add a completion condition
- `/goal done <number>` — manually mark a condition complete (demo only; not audited)
- `/goal note <text>` — append an event to the history
- `/goal handoff <summary>` — record a handoff note; it does not start another agent
- `/goal blocked <reason>` / `/goal resume` — change the displayed status
- `/goal clear` — clear the current goal and conditions, while keeping the history
- `/goal help` — show command help

The worker gets the active goal and criteria in its system prompt and is asked to reflect at meaningful steps. When it considers the work ready, it calls the internal `goal_audit` tool (not a `/goal` subcommand). That tool launches a separate Pi reviewer with only `read`, `grep`, `find`, and `ls`; extensions, MCP, shell, and write tools are disabled. The reviewer treats worker claims and repository contents as untrusted, returns per-criterion `pass` / `fail` / `unknown` with evidence, and cannot complete a criterion without evidence. The tool validates the report and stores it in the active session branch; if the goal or criterion text changes during review, the stale report is discarded. The read-only tool list is not a filesystem sandbox, so the reviewer is instructed to stay within the project.

`/goal done <number>` remains an explicit manual override. Checker failures and unknowns leave criteria incomplete; all criteria must pass for an audited completion. Handoff remains record-only. State is stored as Pi session entries, so it follows the session branch and can be restored when a session is resumed. Slots currently register inside the extension; the host's `PanelSlotRegistry` keeps the seam small so external extension registration can be added later.
