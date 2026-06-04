---
name: test-gaps
description: Detect missing test coverage and generate test suggestions
argument-hint: "[--threshold N] [--critical-only] [--path PATH]"
allowed-tools: Bash(npx *) mcp__ruflo__hooks_worker-dispatch Read Grep
---
Find test coverage gaps via CLI:
```bash
npx @sparkleideas/cli@latest hooks coverage-gaps --threshold 80 --critical-only
npx @sparkleideas/cli@latest hooks coverage-route --task "add auth tests"
npx @sparkleideas/cli@latest hooks coverage-suggest --path src/ --limit 20
```
(`coverage-gaps` has no `--limit` flag — its real options are `--threshold`,
`--critical-only`, `--group-by-agent`. The `--limit` flag is real on
`coverage-suggest`; on the MCP surface a `limit` param applies there too.)

Or dispatch the testgaps worker via MCP:
`mcp__ruflo__hooks_worker-dispatch({ trigger: "testgaps" })`

For continuous detection, use `/loop` with the `loop-worker` skill targeting the `testgaps` worker.
