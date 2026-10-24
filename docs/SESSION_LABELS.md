# Session labels

Traicer labels your captured sessions on your machine, so you and buyers can see what kind of work a session holds before anyone opens it. A label says things like "a failing test now passes", "the user corrected the agent", or "this session is mostly TypeScript". Labels never contain your prompts, code, file names or commands. They are enum values, counts and yes/no flags.

## What Traicer labels without any setup

Rules read each exchange as it is captured and need no model:

- **The step:** what the agent's tool calls did (read code, edited code, ran tests, ran a build or type check, installed packages, used git), and whether the result succeeded or failed in a recognisable way (tests failed, build error, command not found, permission refused, timeout).
- **The task:** each stretch of work from your request to the agent saying it's done. Traicer records whether a test went from failing to passing after a code change, what checked the result (tests the agent added, existing tests, only a build), and whether the agent claimed tests pass when the last test run failed or no test ran.
- **Test integrity:** edits that newly skip a test or silence a check (`it.skip`, `@ts-ignore`, `eslint-disable`, `|| true`, `as any`).
- **The session:** the main languages, counts of the above, and an outcome such as "completed and verified".

## Richer labels with a local classifier

Some labels need a judgement: what kind of task you asked for, whether your next message accepted or corrected the agent's work, or whether an edit to a test weakened it. For those, Traicer can call a classifier that speaks the `/v1/systemone` format (the format TypeSafe Jev uses) running on your own machine, such as Von, Kev, Rizzo Flow or laya-serve.

Set these before `traicer start`:

| Variable | Meaning |
| --- | --- |
| `TRAICER_CLASSIFIER_URL` | Base URL of the local server, for example `http://127.0.0.1:8000`. It must be `127.0.0.1`, `localhost` or `[::1]`. |
| `TRAICER_CLASSIFIER_MODEL` | Optional model name sent with each request. Defaults to `jev-latest`. |
| `TRAICER_CLASSIFIER_API_KEY` | Optional bearer token, if your local server requires one. |

Traicer refuses any classifier address that is not on this machine, and it does not follow redirects, so redacted session text never leaves your computer for labelling. It only builds classifier requests from the redacted trace. If the classifier is slow or offline, Traicer keeps capturing and falls back to the rule labels. Answers below 80% confidence are stored but don't count towards inventory.

## Where labels go

Labels are stored in `traicer-state.db` next to your other local inventory. The metadata tab in `traicer explore` shows them for each trace and its session.

When Traicer publishes your inventory to Traice Market, a segment can include label-based filters: `language`, `task`, `domain`, `outcome` and `signals` (`fail_to_pass`, `verified_completion`, `human_correction`, `test_tampering`, `suppressed_checks`, `unsupported_claim`). A value is included only when at least three sessions and ten committed traces in that segment carry it, so a filter can't single out one session. Per-trace labels are not sent.

Sessions close after 30 minutes without a new exchange. Traicer republishes inventory at most once an hour when labels have changed.
