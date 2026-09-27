/**
 * purse/config.ts — the ONLY place in this codebase that reads the spend policy.
 *
 * Rules this module enforces, by construction:
 *
 *  1. Every value originates in `process.env`. There is no default, no fallback,
 *     no CLI flag, no HTTP header, and no LLM-visible override.
 *  2. Money is `bigint` base units. Floats cannot survive parsing, so a value
 *     like "0.05" is a boot-time error rather than a silent $0.
 *  3. The exported object is deeply frozen. A caller cannot mutate the policy
 *     at runtime to raise a cap.
 *  4. Malformed or missing configuration throws at import time. The process
 *     does not come up "mostly configured".
 *
 * If you find yourself wanting to construct one of these values somewhere else,
 * the fix is to change the operator's environment, not the code.
 */
/*
 * The environment must exist before this module's body runs, because
 * `loadConfig()` is called at module level (see the bottom of this file) and
 * throws on a missing policy. Importing the loader *here* rather than asking each
 * entry point to remember it is the whole point: ESM evaluates a module's
 * imports before its own body, so every consumer of `config` — the agent, both
 * sellers, every script, the tests — gets a populated `process.env` without
 * having to know this module exists. See `purse/env.ts` for why the ordering is
 * enforced here and not by import position.
 */
import './env.js';
import { isAddress } from 'viem';
import { z } from 'zod';

/** CAIP-2 asset/network identifiers, e.g. `eip155:84532` (Base Sepolia). */
const CAIP2_ID = /^[a-z0-9-]+:[-A-Za-z0-9%]{1,128}$/;

/**
 * Hard refusal for chains where a real-tokens mistake is irreversible.
 * Testnet use is a product requirement here, not a preference, so it is
 * enforced as a boot error rather than documented in a README.
 */
const MAINNET_NETWORKS = new Set([
  'eip155:1', // Ethereum
  'eip155:8453', // Base
  'eip155:10', // Optimism
  'eip155:137', // Polygon
  'eip155:42161', // Arbitrum One
  'eip155:56', // BNB Smart Chain
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', // Solana mainnet
]);

const env = z.object({
  /** Largest single payment the agent may make, in base units. */
  PER_CALL_MAX_BASE_UNITS: z
    .string()
    .regex(/^\d{1,30}$/, 'must be a plain integer string of base units (no decimals, no separators, no exponent)')
    .transform((s) => BigInt(s))
    .refine((v) => v > 0n, 'must be greater than zero'),

  /** Cumulative ceiling across the whole run, in base units. */
  TOTAL_BUDGET_BASE_UNITS: z
    .string()
    .regex(/^\d{1,30}$/, 'must be a plain integer string of base units (no decimals, no separators, no exponent)')
    .transform((s) => BigInt(s))
    .refine((v) => v > 0n, 'must be greater than zero'),

  /** Comma-separated CAIP-2 network ids. */
  ALLOWED_NETWORKS: z
    .string()
    .min(1, 'must not be empty')
    .transform((s) => s.split(',').map((p) => p.trim()))
    .refine((parts) => parts.every((p) => p.length > 0), 'must not contain empty entries')
    .refine(
      (parts) => parts.every((p) => CAIP2_ID.test(p)),
      'each entry must be a CAIP-2 id such as "eip155:84532"',
    )
    .refine(
      (parts) => parts.every((p) => !MAINNET_NETWORKS.has(p)),
      `mainnet is not permitted; testnet only (offending: ${
        [...MAINNET_NETWORKS].join(', ')
      })`,
    ),

  /** Comma-separated token contract addresses. Normalized to lowercase. */
  ALLOWED_ASSETS: z
    .string()
    .min(1, 'must not be empty')
    .transform((s) => s.split(',').map((p) => p.trim()))
    .refine((parts) => parts.every((p) => p.length > 0), 'must not contain empty entries')
    .refine(
      (parts) => parts.every((p) => isAddress(p, { strict: false })),
      'each entry must be a 20-byte EVM contract address',
    )
    .transform((parts) => parts.map((p) => p.toLowerCase())),
});

export interface PurseConfig {
  readonly perCallMaxBaseUnits: bigint;
  readonly totalBudgetBaseUnits: bigint;
  readonly allowedNetworks: readonly string[];
  readonly allowedAssets: readonly string[];
  /** Smallest multiple of the per-call cap that can fit in the budget. */
  readonly maxCallsUnderBudget: bigint;
}

/**
 * Parse and validate a policy from an environment-shaped record.
 *
 * Exported for tests, which need to assert that a hostile environment fails
 * loudly. Production code must use the `config` singleton below.
 */
export function loadConfig(source: Record<string, string | undefined> = process.env): PurseConfig {
  const parsed = env.safeParse({
    PER_CALL_MAX_BASE_UNITS: source.PER_CALL_MAX_BASE_UNITS,
    TOTAL_BUDGET_BASE_UNITS: source.TOTAL_BUDGET_BASE_UNITS,
    ALLOWED_NETWORKS: source.ALLOWED_NETWORKS,
    ALLOWED_ASSETS: source.ALLOWED_ASSETS,
  });

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `coin-purse: invalid spend policy in environment. Refusing to start.\n${detail}\n\n` +
        'See .env.example for the required variables.',
    );
  }

  const { PER_CALL_MAX_BASE_UNITS, TOTAL_BUDGET_BASE_UNITS, ALLOWED_NETWORKS, ALLOWED_ASSETS } = parsed.data;

  if (TOTAL_BUDGET_BASE_UNITS < PER_CALL_MAX_BASE_UNITS) {
    throw new Error(
      'coin-purse: invalid spend policy in environment. Refusing to start.\n' +
        `  - TOTAL_BUDGET_BASE_UNITS (${TOTAL_BUDGET_BASE_UNITS}) is below ` +
        `PER_CALL_MAX_BASE_UNITS (${PER_CALL_MAX_BASE_UNITS}); no payment could ever be made.`,
    );
  }

  return Object.freeze({
    perCallMaxBaseUnits: PER_CALL_MAX_BASE_UNITS,
    totalBudgetBaseUnits: TOTAL_BUDGET_BASE_UNITS,
    allowedNetworks: Object.freeze([...ALLOWED_NETWORKS]),
    allowedAssets: Object.freeze([...ALLOWED_ASSETS]),
    maxCallsUnderBudget: TOTAL_BUDGET_BASE_UNITS / PER_CALL_MAX_BASE_UNITS,
  });
}

/**
 * The live policy. Importing this module with a bad environment throws.
 */
export const config: PurseConfig = loadConfig();
