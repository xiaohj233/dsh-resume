# dsh-resume

English | [中文](README.zh.md)

**Status: Feature Plugin with Compatibility Patch. Tested only with DeepSeek Harness 0.1.0-rc.6.**

`dsh-resume` adds two continuity behaviors to the DSH Web profile: an interrupted turn can continue from an empty submit without adding a visible "continue" message, and sessions that were still running when DSH stopped can be resumed after the next boot.

## Problem

Upstream DSH can resume stored sessions and repair torn logs, but it does not treat an empty composer submission as continuation and does not automatically restart the exact set of sessions and subagents that were active at process shutdown.

## Behavior

- Folds received partial text and reasoning into session history when a turn is interrupted.
- Enables empty-submit continuation for an interrupted conversation.
- Tracks active top-level sessions and subagents in `~/.dsh/resume-state.json`.
- Restores only entries recorded as running at shutdown; completed or user-aborted turns are not restored.
- Consumes the state file per session: each successfully resumed session is removed from the persisted set immediately (atomic write), so a crash or kill during restoration never loses the remaining sessions — the next boot continues with what is left. Failed resumes stay recorded and are retried on the next boot.
- Automatically retries recorded subagents at startup; failed entries remain available through `resume_interrupted_subagents`.
- Writes recovery diagnostics to `~/.dsh/resume-state.log`.

## Non-goals

This package does not import sessions from other agents, rewind arbitrary turns, migrate workspaces, guarantee that a remote provider can reproduce an interrupted stream byte-for-byte, or repair every upstream session-log race.

## Mechanism

The host plugin listens to agent lifecycle events and uses the official `agents.resume` service. Compatibility patches add partial-turn folding and empty-submit handling to:

- `@deepseek-ai/dsh-agent-loop@0.1.0-rc.6`
- `@deepseek-ai/dsh-session@0.1.0-rc.6`
- `@deepseek-ai/dsh-client-ui-conversation@0.1.0-rc.6`

Every target hunk is idempotent and has an explicit reverse operation. Version policy is adaptive by default: a copy whose installed version differs from `0.1.0-rc.6` is still patched when every hunk anchor matches uniquely (recorded as an adaptive match), and skipped with a reason when anchors drifted. The programmatic `strict` option restores the old exact-version-only apply behavior. One drifted copy never blocks the others, and patch application never throws during module loading, so an upstream upgrade cannot brick the agent loop. Restore remains strictly version-guarded in every mode.

## Compatibility

Tested with DeepSeek Harness `0.1.0-rc.6`, Node.js `^22.19.0 || >=24`, and pnpm `>=10`. After an upstream upgrade, run `dsh-resume-restore` and `verify:anchors` once to confirm every hunk is either applied or intentionally skipped.

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
pnpm --dir "$DSH_HOME/profiles/web" exec dsh-resume-restore
dsh plugin --profile web remove dsh-resume
```

When `$DSH_HOME` is unset the profile lives under the home directory (POSIX: `~/.dsh/profiles/web`; Windows PowerShell: `%USERPROFILE%\.dsh\profiles\web`); on Windows pass the resolved path to `pnpm --dir` instead of `~`. Normal Cordis shutdown does **not** reverse patches; shutdown is when continuity state must be preserved.

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
