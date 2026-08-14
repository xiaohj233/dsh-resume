# dsh-resume

**Status: Feature Plugin with Compatibility Patch. Tested only with DeepSeek Harness 0.1.0-rc.6.**

`dsh-resume` adds two continuity behaviors to the DSH Web profile: an interrupted turn can continue from an empty submit without adding a visible "continue" message, and sessions that were still running when DSH stopped can be resumed after the next boot.

## Problem

Upstream DSH can resume stored sessions and repair torn logs, but it does not treat an empty composer submission as continuation and does not automatically restart the exact set of sessions and subagents that were active at process shutdown.

## Behavior

- Folds received partial text and reasoning into session history when a turn is interrupted.
- Enables empty-submit continuation for an interrupted conversation.
- Tracks active top-level sessions and subagents in `~/.dsh/resume-state.json`.
- Restores only entries recorded as running at shutdown; completed or user-aborted turns are not restored.
- Automatically retries recorded subagents at startup; failed entries remain available through `resume_interrupted_subagents`.
- Writes recovery diagnostics to `~/.dsh/resume-state.log`.

## Non-goals

This package does not import sessions from other agents, rewind arbitrary turns, migrate workspaces, guarantee that a remote provider can reproduce an interrupted stream byte-for-byte, or repair every upstream session-log race.

## Mechanism

The host plugin listens to agent lifecycle events and uses the official `agents.resume` service. Compatibility patches add partial-turn folding and empty-submit handling to:

- `@deepseek-ai/dsh-agent-loop@0.1.0-rc.6`
- `@deepseek-ai/dsh-session@0.1.0-rc.6`
- `@deepseek-ai/dsh-client-ui-conversation@0.1.0-rc.6`

Every target version and structural anchor is checked before any file is written. A missing or duplicate anchor refuses the whole operation. Patches are idempotent and have an explicit reverse operation.

## Compatibility

Requires DeepSeek Harness `0.1.0-rc.6`, Node.js `^22.19.0 || >=24`, and pnpm `>=10`. Other DSH versions are intentionally refused rather than patched optimistically.

## Install

```sh
dsh plugin --profile web add "github:xiaohj233/dsh-resume#v0.1.0"
```

Restart the Web profile. Startup applies the guarded compatibility patches before enabling resume behavior.

## Configuration

Override the `dsh-resume` row in a later profile patch when needed:

```yaml
- id: dsh-resume
  config:
    enabled: true
    restoreDelayMs: 2000
```

`enabled` controls startup restoration. Runtime tracking remains active so a later enabled boot can restore the recorded set.

## Restore and uninstall

Restore official package files before removing the plugin:

```sh
pnpm --dir ~/.dsh/profiles/web exec dsh-resume-restore
dsh plugin --profile web remove dsh-resume
```

On Windows, replace `~/.dsh` with the configured `%DSH_HOME%` path if it differs. Normal Cordis shutdown does **not** reverse patches; shutdown is when continuity state must be preserved.

After uninstall, `resume-state.json` and `resume-state.log` are no longer read. Delete them manually if their session identifiers and diagnostics are no longer needed.

## Safety and privacy

The state and log files contain session/subagent identifiers, model and recovery diagnostics, and failure messages. They do not intentionally store credential values, but they should be treated as private runtime data. Automatic restoration can issue new model requests and incur provider usage.

## Tests

```sh
npm test
npm run check
npm pack --dry-run
```

The test suite covers exact version refusal, unique-anchor refusal, whole-run atomicity, idempotence, byte-exact patch/restore round trips, normal-shutdown behavior, and restore CLI failures.

## Limitations and upstream status

Upstream already provides `resumeSessionId`, interrupted-turn closers, checkpoints, and session persistence. This package builds on those mechanisms and patches only the missing empty-continuation and shutdown-set restoration behavior. DSH Discussion #420 documents an upstream resume/closer sequence race that this package does not claim to eliminate.

## License

MIT. Patch targets are MIT-licensed; see `THIRD_PARTY_NOTICES.md`.
