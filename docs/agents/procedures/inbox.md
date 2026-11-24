# Stephen's Inbox

How agents reach Stephen when he is not in the chat.

## The three sections

- **Asks:** what only Stephen can do or decide. Each is one command, kept in the event log and shown on the dashboard. How: "Asking Stephen" below.
- **To review:** choices agents made without him. Each says what was chosen, why, where it lives, and how to undo it. Keep them short, one item per slice where you can: a long list goes unread. When he has read one, move it to `docs/reviewed-choices.md`, or, if he wants a change, to "Decided, to apply".
- **Decided, to apply:** his answers, waiting for an agent to put them into a plan, the roadmap, or a decision file. The next head agent applies them first, then deletes them.

The last two are sections of `docs/awaiting-decisions.md`. Only the head agent edits that file, newest items at the top of each section. The line at the top of the file says whether the loop is running or stopped, and what Stephen should look at first. The status command counts the items.

## Asking Stephen

What needs him is the stop list in `docs/agents/core.md` ("What only Stephen does"). Workers never ask (CORE-6); they write the question in the plan log and stop. A head agent that hits the list does not wait:

1. File an ask:

   ```sh
   node scripts/ask.mjs new --title "Pay for the bigger database plan?" --why "One or two sentences." \
     --blocks "Slice 012, task 3" --option "A: Pay now" --option "B: Wait a month" --recommend A --slice 12
   ```

   The title is a question, or starts with a verb, in 80 characters or fewer. The why is 300 at most, the blocks text 120, and there are at most 4 options. Put the exact step for Stephen (a command or a link) in the why. The script refuses anything too long and says what to cut (exit 2). It prints the ask's id.
2. Carry on with every task that does not need the answer. A slice that cannot go on is blocked (`docs/agents/procedures/blocked-slice.md`).
3. Stephen answers on the dashboard, or with `node scripts/ask.mjs answer <id> --choice A`. In T3 Code the answer is sent to the thread that asked, as a message, so do not keep checking. Act on it when it arrives.
4. `node scripts/ask.mjs list --open` shows what still waits. An answer that reached no thread (asked outside T3 Code, or the message failed) shows in `node scripts/ask.mjs list --answered --json` with a `delivery` status other than `sent`: the next head agent puts it under "Decided, to apply" if no plan holds it yet.

Older projects may still have items under a "Your to-do" heading. The dashboard shows them; answer one with `node scripts/ask.mjs answer legacy-<id> --text "..."`. Add no new ones.

## What does not belong here

- Routine events, such as each new app build. Mention a recurring event only when it changes what he must do, and say it once.
- Topics Stephen wants to look into more deeply before anything is built. Those live in `docs/planning-required.md`, his own list. A topic goes there only when he says so. If he wants to dig into an ask or an item first, move it there. Agents research or plan a topic only when he asks; it leaves only when he decides.

## Big decisions

A choice that affects more than one slice, or would be costly to reverse, gets a decision file from `docs/decisions/000-template.md`. Each one says what would make us change our mind, in a form someone can check.
