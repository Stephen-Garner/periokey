# Security Pass

A short list of questions a deep review asks of the change (`docs/agents/procedures/review-levels.md`). Ask them of the changed code, not of the whole project. An answer that shows a risk nothing guards is a finding, and an open security finding is always Important.

1. **Who can call this?** Is that checked on the server, every time, and not only on the screen?
2. **Whose data can it read or change?** Can one user reach another user's data by changing an id in a request?
3. **Is any outside input trusted?** Input from a user, a file, a web page, or another service is checked for shape and size before it is used, for example with a schema library such as Zod.
4. **Does a secret reach a log, an error message, or the client** (the app on the user's phone or in their browser)?
5. **Does it delete or overwrite with no way back?** Is there a copy, an undo, or a step that asks first?
6. **Does it add a package?** Is it well known, kept up, and really needed?
7. **Does it touch money or sign-in?** Then a test covers each risky path, including the one where the check fails.

Write the result in the reply as `SECURITY: clear` (no open question) or `SECURITY: open` (at least one), and give each open question as a finding: file and line, what could go wrong, and the fix you suggest.

Never read real secret values to answer question 4: read the code that handles them. Reading or moving secrets is on the stop list (`docs/agents/core.md`, "What only Stephen does").
