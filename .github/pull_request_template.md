<!-- One focused change per pull request. Explain what you observed, not just what you changed. -->

## Before

<!-- What happened before this change: the bug, the missing behaviour, or the friction. Include output, logs or a screenshot when it helps. -->

## After

<!-- What happens now. Note anything that behaves differently for people, for agents (MCP tools), or on one OS only. -->

## How

<!-- How it works, and how you checked it: commands you ran, apps or devices you tried, what you could not test. -->

## Checklist

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] Tests added or updated (replay a real transcript where possible)
- [ ] `CHANGELOG.md` has a line under the top version, if users will notice the change
- [ ] Docs updated (README, AGENTS.md, docs/) if behaviour or setup changed
- [ ] If `plugins/baton/` changed: `claude plugin validate --strict ./plugins/baton`, `claude plugin test ./plugins/baton` and `node scripts/check-plugin-version.mjs`
