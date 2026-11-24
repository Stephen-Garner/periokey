# When a Slice Waits on Stephen

A slice is not done while a task needs Stephen: a login, a device, money, a decision. Do not stop there, and do not wait.

1. Finish every task that does not need him.
2. File an ask (`docs/agents/procedures/inbox.md`): what he must do, the exact step, and what waits on it.
3. Set the plan `status: blocked`, and say in a dated note in its plan log (`docs/plans/logs/NNN-short-name.md`) which task waits and why.
4. Do the closing steps that still apply (`docs/agents/procedures/close-a-slice.md`, from step 5), then start a fresh thread for the next slice that passes the gates.
5. When Stephen does his part, the thread he talks to sets the plan back to `in_progress` and finishes it.
6. A slice stopped on purpose (for example at its token limit) is set `status: parked` instead, with a dated note in its plan log. The head agent splits it into smaller slices or files an ask; it goes back to `in_progress` only after that.

The same goes for anything on the stop list in `docs/agents/core.md` ("What only Stephen does"): file an ask, and move on to work that does not need it.
