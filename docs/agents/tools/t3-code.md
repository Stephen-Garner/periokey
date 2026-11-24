# Tool Names: T3 Code

The other guides say what to do in plain words. This file says which T3 Code tool does each one. It is the only agent guide that names T3 tools, so a T3 change means one edit here.

T3 tools may load late: try a tool's name once before you call it missing.

| Plain words | T3 Code tool | Notes |
|---|---|---|
| See which models you can start | `orchestrator_capabilities` | Once per thread, before your first `delegate_task`. |
| Start a worker | `delegate_task` with `isolation: "worktree"` | Put the provider and model in `target` (`providerInstanceId`, `model`). A worker on another company's model, such as a Codex reviewer under a Claude head agent, must go through `delegate_task`: your tool's own subagent feature runs only its own company's models. |
| Start a re-check | A new `delegate_task` | Never `t3_thread_send` to the old worker. |
| Wait for a worker | Its finished notice | Never `task_status` in a loop, never sleep. |
| Nudge a worker that stopped early | `t3_thread_send` to its thread | The only message a running worker gets. |
| Stop a worker you no longer need | `task_cancel` with its `taskId` | Never `t3_thread_interrupt` on its thread. |
| Start the next head agent thread | `t3_thread_launch` in the same project | `workspaceStrategy: {type: "worktree", baseRef: "origin/main", startFromOrigin: true}`, never the project root. Provider and model from the launch settings in `AGENTS.md`. For Claude the provider is `claudeAgent`; there is no provider `claude`. |
| Confirm a thread is running | `t3_thread_read` | Until its status is `running` or `completed` and it has written at least one message. |
| List open threads and their worktree folders | `t3_thread_list` with `includeSubagents: true` and `settled: false` | The cleanup script asks T3 Code itself. Pass a thread's `worktreePath` as `--in-use` only to keep an extra folder. |
| Link a pull request to a thread | `link_pull_request` | Right after `gh pr create`, and for every pull request you push to. For a helper thread's placeholder, pass that thread's `threadId`. |
| Settle a finished thread you started | `t3_thread_organize` with `action: "settle"` | |
| Show Stephen a diagram | `html_preview`, then `html_render` | |
| Use a device | The T3 device tools (`device_list`, `device_open`, `device_screenshot`, `device_close`) | Take the device slot first (`docs/agents/ram-rules.md`). Close your device session when done. |

## Why the thread record exists

T3 Code settles a thread once every pull request linked to it is merged. A settled thread may never wake again. That is the whole reason for `docs/agents/procedures/thread-record.md`.

## Plan header models and launch names are different things

A plan header says `tool/model-id`, for example `claude/claude-opus-5-5`. The `tool/` part is a label for people. To launch, use the provider and model exactly as `orchestrator_capabilities` lists them.
