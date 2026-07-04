# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Interactive CLI tool ("soneium-automation") that automates DeFi operations on the Soneium network (chain 1868) across many wallets: daily check-ins, swaps, bridges, approval revokes, SBT badge mints, and statistics collection from the Soneium portal. Code comments, log messages, and UI text are in Russian.

## Commands

```bash
npm run dev          # Launch interactive menu (main entrypoint, tsx src/index.ts)
npm run build        # tsc → dist/ (also runs on postinstall)
npm run type-check   # tsc --noEmit
npm run lint         # eslint . (tests/ are ignored by eslint)
npm run lint:fix
npm test             # tsx --test tests/*.test.ts (Node built-in test runner)
tsx --test tests/backoff.test.ts   # Run a single test file

npm run <module>     # Run one module on a RANDOM wallet, e.g. npm run jumper
                     # (any key of the registry in src/run-module.ts: arkada-checkin,
                     # lootcoin, jumper, revoke, harkan, velodrome, wowmax, captain-checkin, ...)
```

TypeScript is strict (including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`). ESM project (`"type": "module"`) — all relative imports must use the `.js` extension. Tests are excluded from tsconfig and eslint.

## Runtime Inputs (git-ignored, at repo root)

- `keys.txt` — private keys, one per line; or `keys.encrypted` + `keys.salt` (AES-256-CBC, PBKDF2) managed by `src/key-encryption.ts`. The app offers to encrypt plain keys on startup. **Never read or print these files.**
- `proxy.txt` — HTTP/SOCKS proxies used by `ProxyManager` (singleton) for API requests.
- `mexc_api.txt` — MEXC exchange API creds for wallet top-up withdrawals (`src/mexc-withdraw.ts`).
- Config overrides via env vars (`SONEIUM_RPC_URLS`, `RPC_TIMEOUT_MS`, ...) — see `src/config.ts`.

## Architecture

Two entrypoints:
- `src/index.ts` — interactive app: key loading/validation → `MenuSystem` (menu, statistics + Excel export via portal.soneium.org API, badge mint, collector, Stargate bridge, MEXC top-up) → `ParallelExecutor` for multi-wallet runs.
- `src/run-module.ts` — one-shot CLI: runs a single named module on one random key.

**Module pattern**: each file in `src/modules/` exports `perform<Name>(privateKey) => Promise<ModuleResult>`. `ModuleResult.skipped: true` means "not an error, nothing to do today" (e.g. already checked in) and counts as success. New modules must be registered in **two registries**: the `modules` map in `src/run-module.ts` and the one in `src/parallel-executor.ts` (plus an npm script if a standalone command is wanted).

**ParallelExecutor** (`src/parallel-executor.ts`) drives multi-wallet iterations: rotates modules per wallet via an offset, enforces a per-wallet daily tx cap (`MAX_TX_PER_WALLET_PER_DAY = 15`), and excludes wallets whose `seasonScore >= POINTS_LIMIT_SEASON` (toggle: `GM_IGNORE_POINTS_LIMIT`). Pure wallet prioritization/filter logic lives in `src/wallet-selection.ts` (unit-tested).

**Transaction layer** — modules should not call viem directly for writes:
- `src/rpc-manager.ts` — viem client factory with fallback rotation across several Soneium RPC URLs; exports `rpcManager` and `soneiumChain`.
- `src/transaction-utils.ts` — `safeWriteContract` etc.: pre-send simulation (controlled by `SIMULATE_BEFORE_SEND` / `STRICT_SIMULATION` in season-config), classifies simulation failures (`revert`/`insufficient` block the send; `timeout`/`network` do not), and maps known 4-byte revert selectors to "already done today" → skip instead of fail. New "already checked in" selectors discovered in `logs/failed.txt` get added to the selector lists there.

**Single-source registries** (edit these instead of hardcoding in modules):
- `src/contracts.ts` — all Soneium contract/token addresses.
- `src/season-config.ts` — everything that changes per season: `CURRENT_SEASON`, points threshold, swap percent range, simulation flags, `BADGE_MINT_CONFIG`. A season rollover should only touch this file.
- `src/config.ts` — env-driven runtime config (RPC URLs/timeouts, stats API).

**Support**: `src/logger.ts` + `src/file-logger.ts` (writes `logs/`), `src/backoff.ts` (retry delays), `src/semaphore.ts` (concurrency limiting), `src/shutdown.ts` (`shutdownManager` owns SIGINT/SIGTERM and process exit — don't call `process.exit` directly), `src/metrics.ts`, `src/gas-checker.ts`.
