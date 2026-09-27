/**
 * purse/env.ts — the one place `.env` is read.
 *
 * Why this module exists at all, when `import 'dotenv/config'` is one line:
 *
 * ESM hoists every `import` and evaluates the whole dependency graph
 * depth-first *before* a single statement in the importing module runs. So
 * "put `import 'dotenv/config'` first" is a positional rule that nothing
 * enforces. It works right up until someone adds an import above it, or moves
 * the file, and then `purse/config.ts` — which calls `loadConfig()` at module
 * level and throws on missing values — evaluates first and the process dies
 * with `PER_CALL_MAX_BASE_UNITS: Required` while a perfectly good `.env` sits
 * unread on disk. That is exactly how `agent/agent.ts` failed: it was the one
 * entry point nobody had remembered to add the import to.
 *
 * The fix that does not rot is to invert the dependency. `purse/config.ts`
 * imports *this* module, and ESM guarantees a module's imports are fully
 * evaluated before its own body — so no entry point, present or future, can get
 * the order wrong. `agent`, both sellers, and every script are fixed by
 * construction rather than by discipline.
 *
 * Two deliberate choices:
 *
 *  - `.env` is resolved relative to *this file*, not `process.cwd()`. That is
 *    what `dotenv/config` does, and it means running `npm run agent` from a
 *    parent directory silently loads nothing. Anchoring to the module makes the
 *    load independent of where the command was typed, which is the usual way
 *    this goes wrong on Windows.
 *
 *  - `override: false`. A real environment variable always beats the file. The
 *    operator sets policy, and being able to say
 *    `PER_CALL_MAX_BASE_UNITS=1000 npm run agent` has to keep working; a
 *    `.env` that clobbered the shell would quietly remove that ability. It
 *    also means a developer's real wallet key in `.env` cannot displace a
 *    throwaway one supplied by the test runner.
 */
import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root: this file is `purse/env.ts`, so one level up from `purse`. */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const ENV_PATH = join(REPO_ROOT, '.env');

/**
 * Load `.env` if it is there.
 *
 * Absence is not an error. Supplying the whole policy through the shell is a
 * legitimate way to run this — that is how CI and the test suite work — so a
 * missing file just leaves `process.env` alone and lets `config.ts` report
 * precisely which variables are absent.
 *
 * Nothing here logs, echoes, or returns the file's contents. A `.env` holds the
 * wallet key, and the loader has no business printing it.
 */
export function loadEnv(envPath: string = ENV_PATH): boolean {
  if (!existsSync(envPath)) return false;
  loadDotenv({ path: envPath, override: false, quiet: true });
  return true;
}

loadEnv();
