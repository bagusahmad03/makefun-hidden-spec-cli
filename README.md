# makefun-hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bagusahmad03/makefun-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bagusahmad03/makefun-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one command-line patch tool for every AI edit format — unified diffs (with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and text-editor tool calls as JSON — to one written specification (SPEC.md), all or nothing. Practice set: 100/100 (practice score 1000).

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-`/absent to read it from standard input. Options: `--format=auto|unified|search-replace|v4a|json`, `--check` (dry run: same output and exit code, no files written), `--strict` (exact tier-0 matching only). Node 22, standard library only, nothing to install. The practice set runs with `node check.ts <practice.json>` (the kit's `program/generator/practice.json`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=syht5d66&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
