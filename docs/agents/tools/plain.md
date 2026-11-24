# Without T3 Code

In plain Claude Code or Codex, with no T3 Code around them, some steps change.

| Plain words | What to do |
|---|---|
| Start a worker | Use your tool's own subagent feature, in its own worktree. |
| Start a worker on another company's model | Your tool cannot. Give Stephen the message block from `docs/agents/procedures/hand-out-a-task.md` and ask him to start it in a tool that can. |
| Start the next head agent thread | Your tool cannot chain threads. Tell Stephen the handoff is ready and ask him to start one. The automated loop does not run. |
| Thread record | Nothing settles threads, so the draft pull request is optional. Still write the record. |
| List open threads and their folders | Ask Stephen which sessions are still running, or skip worktree cleanup and say so in the thread record. |
| Hear Stephen's answer to an ask | Nothing sends it to you. Run `node scripts/ask.mjs list --answered`. |
| Device and test slots | The same script, `scripts/slot.mjs`. It needs no T3 tool. |
| Show Stephen a diagram | A Mermaid block in your reply, or an HTML file he can open. |
