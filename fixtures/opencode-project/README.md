# OpenCode Smoke Fixture (PHASE 10 §26)

A tiny TypeScript project used as a real-world workspace for the
GigaChat V2 connector smoke test (`scripts/smoke/run-smoke.sh`).

```
src/
  hello.ts     — trivial greeting module (read-and-explain scenario)
  math.ts      — math helpers with two LATENT bugs (fix scenarios)
tests/
  hello.test.ts — passing baseline test
```

Run tests with Bun:

```bash
bun test
```

Scenario flow (see `scripts/smoke/run-smoke.sh`):

1. Explain `src/hello.ts`.
2. Find and fix the bug in `factorial()` in `src/math.ts`.
3. Add unit tests for `factorial`, `fibonacci`, `isEven`.
4. Run the suite and fix the remaining failure (`isEven`).
5. Use two independent tools in parallel.
6. Use the MCP `fs` filesystem server + local tools.