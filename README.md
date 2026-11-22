# make-fun-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ilhamramadan28/make-fun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ilhamramadan28/make-fun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. `mend` applies AI-written edits in four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON — to a tree of text files, to the specification in the make.fun kit. It finds the lines an edit names at the first of three matching tiers (exact, trailing whitespace, leading and trailing whitespace), and changes every file or none. Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty, $100 in USDC.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Node 22, standard library only. See SPEC.md in the kit for the contract.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wa8qfxzr&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
