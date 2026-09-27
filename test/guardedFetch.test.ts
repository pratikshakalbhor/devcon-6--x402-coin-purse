/**
 * test/guardedFetch.test.ts
 *
 * The tests are organised around the question an auditor actually asks: "what
 * would it take to make this thing spend money it should not?"
 *
 * The most important property is negative. For every refusal path we assert
 * two things, not one:
 *
 *   1. the result is a refusal, and
 *   2. the HTTP exchange contained exactly one request and no payment header,
 *      i.e. no signature was ever produced.
 *
 * Asserting only (1) would pass against an implementation that signed a
 * payment and then declined to send it, which is a wallet-draining bug wearing
 * a refusal's clothes.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements, SchemeNetworkClient } from '@x402/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config, loadConfig } from '../purse/config.js';
import {
  baseUnitsToDecimal,
  createPurseClient,
  formatBaseUnits,
  guardedFetch,
  judgeQuote,
  selectCheapest,
} from '../purse/guardedFetch.js';
import { createLedger, type Ledger } from '../purse/ledger.js';
import { paidFetch, paidFetchTool } from '../purse/tool.js';
import { startRogueServer } from '../sellers/rogue-stall.js';
import { buildHonestRoutes } from '../sellers/honest-stall.js';
import { runAgent, buildSystemPrompt, type AgentModel } from '../agent/agent.js';

const BASE_SEPOLIA = 'eip155:84532';
const BASE_SEPOLIA_USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const BASE_MAINNET_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

let dir: string;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coin-purse-test-'));
  ledger = createLedger(join(dir, 'spend.db'));
});

afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function req(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: BASE_SEPOLIA,
    asset: BASE_SEPOLIA_USDC,
    amount: '10000',
    payTo: '0x000000000000000000000000000000000000dEaD',
    maxTimeoutSeconds: 30,
    extra: {},
    ...overrides,
  };
}

/** A scheme that signs nothing, so tests need no chain, key, or RPC. */
/**
 * Counts calls to the one function that turns an approved quote into a
 * signature.
 *
 * `createPaymentPayload` is the closest thing to "sign" in the x402 client: it
 * is where a real scheme would build and sign the EIP-712/EIP-3009 payload. A
 * spy here proves the guard declined *before* reaching the point of authorising
 * anything, which is a stronger claim than "no payment header was sent" — an
 * implementation could sign and then fail to transmit, and only this catches
 * that.
 */
interface SignerSpy {
  readonly callCount: number;
  /** Mutable so the scheme can record into it; read-only to assertions. */
  readonly calls: Array<{ amount: string; asset: string; network: string }>;
  reset(): void;
}

function makeSignerSpy(): SignerSpy {
  const calls: Array<{ amount: string; asset: string; network: string }> = [];
  return {
    get callCount() {
      return calls.length;
    },
    calls,
    reset() {
      calls.length = 0;
    },
  };
}

function makeScheme(spy: SignerSpy): SchemeNetworkClient {
  return {
    scheme: 'exact',
    createPaymentPayload: async (x402Version, requirements) => {
      spy.calls.push({
        amount: requirements.amount,
        asset: String(requirements.asset),
        network: String(requirements.network),
      });
      return {
        x402Version,
        payload: { stub: true, acceptedAmount: requirements.amount },
      };
    },
  };
}

/**
 * An x402 client wired exactly like the real one, but with a stub scheme whose
 * payload creation is spied on. The selector and the spend controls are the
 * production values, so the guard is tested against the same selection and
 * filtering behaviour it will see.
 */
function testClientWith(spy: SignerSpy): x402HTTPClient {
  const scheme = makeScheme(spy);
  let client = new x402Client(selectCheapest);
  for (const network of config.allowedNetworks) {
    client = client.register(network as `eip155:${string}`, scheme);
  }
  return new x402HTTPClient(
    client.setSpendControls({
      maxAmountPerPayment: `${baseUnitsToDecimal(config.perCallMaxBaseUnits)} USDC`,
      allowedAssets: config.allowedNetworks.map((network) => ({
        network: network as `eip155:${string}`,
        asset: BASE_SEPOLIA_USDC as `0x${string}`,
        maxAmountPerPayment: config.perCallMaxBaseUnits.toString(),
      })),
    }),
  );
}

function testClient(): x402HTTPClient {
  return testClientWith(makeSignerSpy());
}

interface FakeSeller {
  fetchImpl: typeof globalThis.fetch;
  /** Every request the purse made, in order. */
  calls: Array<{ url: string; headers: Record<string, string> }>;
  /** Did the purse ever send a signed payment? */
  sentPayment(): boolean;
  /** The payment header the purse sent on its last paid request, if any. */
  lastPaymentHeader(): string | null;
}

interface FakeSellerOptions {
  accepts?: PaymentRequirements[] | null;
  omitPaymentRequiredHeader?: boolean;
  status?: number;
  /** Answer the first request with 200 and no payment demand. */
  free?: boolean;
  /** Settle successfully on the paid retry. Default true. */
  settle?: boolean;
  body?: string;
}

function fakeSeller(options: FakeSellerOptions = {}): FakeSeller {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const settle = options.settle ?? true;

  const fetchImpl = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url, headers });

    const offered = options.accepts === undefined ? [req()] : options.accepts;
    const paymentHeader = headers['payment-signature'] ?? headers['x-payment'];

    if (!paymentHeader) {
      if (options.free) {
        return new Response(JSON.stringify({ ok: true, content: 'free content' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (offered === null || options.omitPaymentRequiredHeader) {
        return new Response(JSON.stringify({ error: 'payment required' }), {
          status: 402,
          headers: { 'content-type': 'application/json' },
        });
      }
      const paymentRequired: PaymentRequired = {
        x402Version: 2,
        resource: { url, description: 'test resource', mimeType: 'application/json' },
        accepts: offered,
      };
      return new Response(JSON.stringify({ error: 'payment required' }), {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired),
        },
      });
    }

    if (!settle) {
      return new Response(JSON.stringify({ error: 'settlement failed' }), { status: 402 });
    }

    return new Response(options.body ?? JSON.stringify({ ok: true, content: 'the good stuff' }), {
      status: options.status ?? 200,
      headers: {
        'content-type': 'application/json',
        'PAYMENT-RESPONSE': encodePaymentResponseHeader({
          success: true,
          transaction: `0x${'ab'.repeat(32)}`,
          network: BASE_SEPOLIA,
          payer: '0x1111111111111111111111111111111111111111',
        }),
      },
    });
  }) as typeof globalThis.fetch;

  return {
    fetchImpl,
    calls,
    sentPayment: () => calls.some((c) => 'payment-signature' in c.headers || 'x-payment' in c.headers),
    lastPaymentHeader: () => {
      for (let i = calls.length - 1; i >= 0; i--) {
        const h = calls[i]!.headers;
        const header = h['payment-signature'] ?? h['x-payment'];
        if (header) return header;
      }
      return null;
    },
  };
}

/** Assert a refusal signed nothing and made only the single quoting request. */
function expectNoPaymentAttempt(seller: FakeSeller): void {
  expect(seller.sentPayment()).toBe(false);
  expect(seller.calls).toHaveLength(1);
}

const URL_UNDER_TEST = 'http://seller.test/article';

// ---------------------------------------------------------------------------
// config: the policy cannot be built any other way
// ---------------------------------------------------------------------------

describe('purse/config', () => {
  const good = {
    PER_CALL_MAX_BASE_UNITS: '50000',
    TOTAL_BUDGET_BASE_UNITS: '5000000',
    ALLOWED_NETWORKS: BASE_SEPOLIA,
    ALLOWED_ASSETS: BASE_SEPOLIA_USDC,
  };

  it('parses money as bigint, never a float', () => {
    const parsed = loadConfig(good);
    expect(typeof parsed.perCallMaxBaseUnits).toBe('bigint');
    expect(parsed.perCallMaxBaseUnits).toBe(50_000n);
    expect(parsed.totalBudgetBaseUnits).toBe(5_000_000n);
  });

  it('rejects a decimal string instead of rounding it', () => {
    expect(() => loadConfig({ ...good, PER_CALL_MAX_BASE_UNITS: '0.05' })).toThrow(/integer string/);
  });

  it('rejects scientific notation, separators, signs, and zero', () => {
    for (const bad of ['5e4', '50_000', '+50000', '-50000', '0', ' 50000', '50000 ']) {
      expect(() => loadConfig({ ...good, PER_CALL_MAX_BASE_UNITS: bad }), bad).toThrow();
    }
  });

  it('throws when anything is missing', () => {
    for (const key of Object.keys(good) as Array<keyof typeof good>) {
      const partial: Record<string, string> = { ...good };
      delete partial[key];
      expect(() => loadConfig(partial), key).toThrow(/invalid spend policy/);
    }
  });

  it('refuses mainnet even when it is otherwise well formed', () => {
    expect(() => loadConfig({ ...good, ALLOWED_NETWORKS: 'eip155:1' })).toThrow(/mainnet/);
    expect(() => loadConfig({ ...good, ALLOWED_NETWORKS: 'eip155:8453' })).toThrow(/mainnet/);
  });

  it('rejects a malformed asset address', () => {
    expect(() => loadConfig({ ...good, ALLOWED_ASSETS: 'not-an-address' })).toThrow(/contract address/);
  });

  it('rejects a budget below the per-call cap, which could never spend anything', () => {
    expect(() =>
      loadConfig({ ...good, PER_CALL_MAX_BASE_UNITS: '100', TOTAL_BUDGET_BASE_UNITS: '50' }),
    ).toThrow(/below/);
  });

  it('is deeply frozen, so a cap cannot be raised at runtime', () => {
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.allowedNetworks)).toBe(true);
    expect(Object.isFrozen(config.allowedAssets)).toBe(true);
    expect(() => {
      (config as { perCallMaxBaseUnits: bigint }).perCallMaxBaseUnits = 10n ** 18n;
    }).toThrow();
  });

  it('normalises assets to lowercase so casing cannot bypass the allowlist', () => {
    const parsed = loadConfig({ ...good, ALLOWED_ASSETS: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' });
    expect(parsed.allowedAssets).toEqual([BASE_SEPOLIA_USDC]);
  });
});

// ---------------------------------------------------------------------------
// ledger: totals are derived from disk
// ---------------------------------------------------------------------------

describe('purse/ledger', () => {
  it('records paid and refused decisions alike', () => {
    ledger.recordDecision({ url: 'a', network: BASE_SEPOLIA, asset: BASE_SEPOLIA_USDC, quotedAmountBaseUnits: 10_000n, decision: 'paid', reason: 'ok' });
    ledger.recordDecision({ url: 'b', network: BASE_SEPOLIA, asset: BASE_SEPOLIA_USDC, quotedAmountBaseUnits: 99_000n, decision: 'refused', reason: 'too expensive' });

    const snapshot = ledger.getSnapshot();
    expect(snapshot.paidCount).toBe(1);
    expect(snapshot.refusedCount).toBe(1);
    // A refused quote is recorded but never counted as spend.
    expect(snapshot.cumulativeSpentBaseUnits).toBe(10_000n);
  });

  it('stores quoted_amount as TEXT, not a float or an integer column', () => {
    ledger.recordDecision({ url: 'a', network: BASE_SEPOLIA, asset: BASE_SEPOLIA_USDC, quotedAmountBaseUnits: 12_345n, decision: 'paid', reason: 'ok' });
    const rows = ledger.getRows();
    expect(typeof rows[0]!.quotedAmountBaseUnits).toBe('bigint');
    expect(rows[0]!.quotedAmountBaseUnits).toBe(12_345n);
  });

  it('sums exactly, with no float drift, past 2^53', () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1, unrepresentable as a double
    ledger.recordDecision({ url: 'a', network: BASE_SEPOLIA, asset: BASE_SEPOLIA_USDC, quotedAmountBaseUnits: huge, decision: 'paid', reason: 'ok' });
    ledger.recordDecision({ url: 'b', network: BASE_SEPOLIA, asset: BASE_SEPOLIA_USDC, quotedAmountBaseUnits: 1n, decision: 'paid', reason: 'ok' });
    expect(ledger.getCumulativeSpent()).toBe(huge + 1n);
  });

  it('reads the total from disk in a brand new handle, not from memory', () => {
    ledger.recordDecision({ url: 'a', network: BASE_SEPOLIA, asset: BASE_SEPOLIA_USDC, quotedAmountBaseUnits: 30_000n, decision: 'paid', reason: 'ok' });
    const path = ledger.path;
    ledger.close();

    // Stands in for a process restart: new connection, zero carried state.
    const reopened = createLedger(path);
    expect(reopened.getCumulativeSpent()).toBe(30_000n);
    reopened.recordDecision({ url: 'b', network: BASE_SEPOLIA, asset: BASE_SEPOLIA_USDC, quotedAmountBaseUnits: 20_000n, decision: 'paid', reason: 'ok' });
    expect(reopened.getCumulativeSpent()).toBe(50_000n);
    reopened.close();

    ledger = createLedger(path);
  });

  it('refuses to record a non-bigint amount', () => {
    expect(() =>
      ledger.recordDecision({
        url: 'a',
        network: BASE_SEPOLIA,
        asset: BASE_SEPOLIA_USDC,
        // @ts-expect-error deliberately wrong: a float must not reach the ledger
        quotedAmountBaseUnits: 0.05,
        decision: 'paid',
        reason: 'ok',
      }),
    ).toThrow(/must be a bigint/);
  });

  it('enforces the paid/refused check constraint', () => {
    expect(() =>
      ledger.recordDecision({
        url: 'a',
        network: BASE_SEPOLIA,
        asset: BASE_SEPOLIA_USDC,
        quotedAmountBaseUnits: 1n,
        // @ts-expect-error deliberately wrong
        decision: 'maybe',
        reason: 'ok',
      }),
    ).toThrow();
  });

  it('back-fills a transaction hash after settlement', () => {
    const row = ledger.recordDecision({ url: 'a', network: BASE_SEPOLIA, asset: BASE_SEPOLIA_USDC, quotedAmountBaseUnits: 5n, decision: 'paid', reason: 'ok' });
    expect(row.txHash).toBeNull();
    ledger.recordSettlement(row.id, '0xdeadbeef');
    expect(ledger.getRows()[0]!.txHash).toBe('0xdeadbeef');
  });
});

// ---------------------------------------------------------------------------
// judgeQuote: the policy, as a pure function
// ---------------------------------------------------------------------------

describe('judgeQuote', () => {
  it('allows a price within both caps', () => {
    expect(judgeQuote(req({ amount: '50000' }), 0n).allowed).toBe(true);
  });

  it('allows a price that lands exactly on the total budget', () => {
    expect(judgeQuote(req({ amount: '10000' }), 4_990_000n).allowed).toBe(true);
  });

  it('refuses one base unit over the per-call cap', () => {
    const result = judgeQuote(req({ amount: '50001' }), 0n);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('over_per_call_max');
  });

  it('refuses one base unit over the total budget', () => {
    const result = judgeQuote(req({ amount: '10000' }), 4_990_001n);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('over_total_budget');
  });

  it('refuses an empty purse', () => {
    expect(judgeQuote(req(), config.totalBudgetBaseUnits).code).toBe('over_total_budget');
  });

  it('refuses a mainnet network', () => {
    const result = judgeQuote(req({ network: 'eip155:8453' }), 0n);
    expect(result.code).toBe('network_not_allowed');
  });

  it('refuses a token that is not on the allowlist', () => {
    const result = judgeQuote(req({ asset: BASE_MAINNET_USDC }), 0n);
    expect(result.code).toBe('asset_not_allowed');
  });

  it('matches assets case-insensitively, so casing is not an escape hatch', () => {
    expect(judgeQuote(req({ asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }), 0n).allowed).toBe(true);
  });

  it('refuses a scheme that does not fix the amount in advance', () => {
    expect(judgeQuote(req({ scheme: 'upto' }), 0n).code).toBe('scheme_not_allowed');
  });

  it('refuses a decimal amount rather than coercing it', () => {
    expect(judgeQuote(req({ amount: '0.05' }), 0n).code).toBe('malformed_quote');
  });

  it('refuses negative, non-numeric, and zero amounts', () => {
    for (const amount of ['-1', '0', 'abc', '', '1e3', ' 10']) {
      expect(judgeQuote(req({ amount }), 0n).allowed, amount).toBe(false);
    }
  });

  it('never spends more than the budget across many small payments', () => {
    let spent = 0n;
    let paid = 0;
    for (let i = 0; i < 1000; i++) {
      const result = judgeQuote(req({ amount: '40000' }), spent);
      if (result.allowed) {
        spent += 40_000n;
        paid++;
      }
    }
    expect(paid).toBe(125); // 5_000_000 / 40_000
    expect(spent).toBe(5_000_000n);
    expect(spent).toBeLessThanOrEqual(config.totalBudgetBaseUnits);
  });
});

// ---------------------------------------------------------------------------
// selectCheapest: the ordering attack
// ---------------------------------------------------------------------------

describe('selectCheapest', () => {
  it('picks the cheapest option regardless of order', () => {
    const cheap = req({ amount: '10000' });
    const ruinous = req({ amount: '40000000' });
    expect(selectCheapest(2, [ruinous, cheap])).toBe(cheap);
    expect(selectCheapest(2, [cheap, ruinous])).toBe(cheap);
  });

  it('ignores options with an unusable amount', () => {
    const good = req({ amount: '10000' });
    expect(selectCheapest(2, [req({ amount: '0.05' }), good])).toBe(good);
  });
});

// ---------------------------------------------------------------------------
// guardedFetch: end to end against a fake seller
// ---------------------------------------------------------------------------

describe('guardedFetch — paying', () => {
  it('pays a fair price and records it with a transaction hash', async () => {
    const seller = fakeSeller({ accepts: [req({ amount: '10000' })] });
    const result = await guardedFetch(URL_UNDER_TEST, {
      ledger,
      client: testClient(),
      fetchImpl: seller.fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.paid).toBe(true);
    expect(seller.calls).toHaveLength(2);
    expect(seller.sentPayment()).toBe(true);

    // The signed payload authorises exactly the judged amount.
    const payload = decodePaymentSignatureHeader(seller.calls[1]!.headers['payment-signature']!);
    expect(payload.accepted.amount).toBe('10000');
    expect(payload.accepted.network).toBe(BASE_SEPOLIA);

    const snapshot = ledger.getSnapshot();
    expect(snapshot.cumulativeSpentBaseUnits).toBe(10_000n);
    expect(snapshot.paidCount).toBe(1);
    expect(snapshot.rows[0]!.txHash).toBe(`0x${'ab'.repeat(32)}`);
  });

  it('quotes with one request and pays with a second', async () => {
    const seller = fakeSeller();
    await guardedFetch(URL_UNDER_TEST, { ledger, client: testClient(), fetchImpl: seller.fetchImpl });
    expect(seller.calls[0]!.headers['payment-signature']).toBeUndefined();
    expect(seller.calls[1]!.headers['payment-signature']).toBeDefined();
  });

  it('takes the cheap option when a ruinous one is listed first', async () => {
    const seller = fakeSeller({ accepts: [req({ amount: '40000000' }), req({ amount: '10000' })] });
    const result = await guardedFetch(URL_UNDER_TEST, { ledger, client: testClient(), fetchImpl: seller.fetchImpl });

    expect(result.ok && result.paid).toBe(true);
    const payload = decodePaymentSignatureHeader(seller.calls[1]!.headers['payment-signature']!);
    expect(payload.accepted.amount).toBe('10000');
    expect(ledger.getCumulativeSpent()).toBe(10_000n);
  });

  it('handles a free endpoint without pricing it or recording anything', async () => {
    const seller = fakeSeller({ free: true });
    const result = await guardedFetch(URL_UNDER_TEST, { ledger, client: testClient(), fetchImpl: seller.fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.paid).toBe(false);
    expect(seller.calls).toHaveLength(1);
    expect(seller.sentPayment()).toBe(false);
    expect(ledger.getSnapshot().rows).toHaveLength(0);
    expect(ledger.getCumulativeSpent()).toBe(0n);
  });
});

describe('guardedFetch — refusing', () => {
  const cases: Array<{ name: string; seller: FakeSeller; code: string }> = [
    { name: 'over the per-call cap', seller: fakeSeller({ accepts: [req({ amount: '5000000' })] }), code: 'over_per_call_max' },
    { name: 'a mainnet network', seller: fakeSeller({ accepts: [req({ network: 'eip155:8453', asset: BASE_MAINNET_USDC })] }), code: 'network_not_allowed' },
    { name: 'an unapproved token', seller: fakeSeller({ accepts: [req({ asset: '0x1111111111111111111111111111111111111111' })] }), code: 'asset_not_allowed' },
    { name: 'a decimal amount', seller: fakeSeller({ accepts: [req({ amount: '0.05' })] }), code: 'malformed_quote' },
    { name: 'a zero amount', seller: fakeSeller({ accepts: [req({ amount: '0' })] }), code: 'malformed_quote' },
    { name: 'a non-exact scheme', seller: fakeSeller({ accepts: [req({ scheme: 'upto' })] }), code: 'scheme_not_allowed' },
    { name: 'an empty accepts list', seller: fakeSeller({ accepts: [] }), code: 'no_acceptable_option' },
    { name: 'a 402 with no protocol header', seller: fakeSeller({ omitPaymentRequiredHeader: true }), code: 'malformed_quote' },
  ];

  for (const { name, seller, code } of cases) {
    it(`refuses ${name} without producing a signature`, async () => {
      const result = await guardedFetch(URL_UNDER_TEST, {
        ledger,
        client: testClient(),
        fetchImpl: seller.fetchImpl,
      });

      expect(result.ok).toBe(false);
      expect(result.paid).toBe(false);
      expect(result.ok === false && result.code).toBe(code);
      expectNoPaymentAttempt(seller);
      expect(ledger.getCumulativeSpent()).toBe(0n);
    });
  }

  it('records the refusal and the price that was quoted', async () => {
    const seller = fakeSeller({ accepts: [req({ amount: '5000000' })] });
    await guardedFetch(URL_UNDER_TEST, { ledger, client: testClient(), fetchImpl: seller.fetchImpl });

    const rows = ledger.getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision).toBe('refused');
    expect(rows[0]!.quotedAmountBaseUnits).toBe(5_000_000n);
    expect(rows[0]!.url).toBe(URL_UNDER_TEST);
    expect(rows[0]!.reason).toMatch(/over_per_call_max/);
    expect(rows[0]!.txHash).toBeNull();
    // Quoted but not paid: the refusal must not move the total.
    expect(ledger.getCumulativeSpent()).toBe(0n);
  });

  it('refuses when the budget is already spent, without contacting the seller twice', async () => {
    ledger.recordDecision({ url: 'prior', network: BASE_SEPOLIA, asset: BASE_SEPOLIA_USDC, quotedAmountBaseUnits: 5_000_000n, decision: 'paid', reason: 'previous run' });
    const seller = fakeSeller({ accepts: [req({ amount: '10000' })] });

    const result = await guardedFetch(URL_UNDER_TEST, { ledger, client: testClient(), fetchImpl: seller.fetchImpl });

    expect(result.ok === false && result.code).toBe('over_total_budget');
    expectNoPaymentAttempt(seller);
    expect(ledger.getCumulativeSpent()).toBe(5_000_000n);
  });

  it('does not throw on a transport failure, and spends nothing', async () => {
    const result = await guardedFetch(URL_UNDER_TEST, {
      ledger,
      client: testClient(),
      fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof globalThis.fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.paid).toBe(false);
    expect(result.ok === false && result.code).toBe('request_failed');
    expect(ledger.getSnapshot().rows).toHaveLength(0);
  });
});

describe('guardedFetch — the cumulative budget holds across many calls', () => {
  it('stops paying at the budget ceiling and refuses the rest', async () => {
    // 40_000 base units per hit, budget 5_000_000 => exactly 125 payable hits.
    const seller = fakeSeller({ accepts: [req({ amount: '40000' })] });
    const client = testClient();

    let paid = 0;
    let refused = 0;
    for (let i = 0; i < 130; i++) {
      const result = await guardedFetch(`${URL_UNDER_TEST}/${i}`, {
        ledger,
        client,
        fetchImpl: seller.fetchImpl,
      });
      if (result.paid) paid++;
      else refused++;
    }

    expect(paid).toBe(125);
    expect(refused).toBe(5);
    expect(ledger.getCumulativeSpent()).toBe(config.totalBudgetBaseUnits);
    expect(ledger.getCumulativeSpent()).toBeLessThanOrEqual(config.totalBudgetBaseUnits);

    // Every refusal in the tail was a budget refusal and signed nothing.
    const rows = ledger.getSnapshot().rows;
    expect(rows.filter((r) => r.decision === 'refused')).toHaveLength(5);
    for (const row of rows.filter((r) => r.decision === 'refused')) {
      expect(row.reason).toMatch(/over_total_budget/);
    }
  });

  it('keeps the cap after a restart, reading the total from disk', async () => {
    const seller = fakeSeller({ accepts: [req({ amount: '40000' })] });
    const client = testClient();
    const path = ledger.path;

    for (let i = 0; i < 125; i++) {
      await guardedFetch(`${URL_UNDER_TEST}/${i}`, { ledger, client, fetchImpl: seller.fetchImpl });
    }
    expect(ledger.getCumulativeSpent()).toBe(config.totalBudgetBaseUnits);
    ledger.close();

    // A new process, with only the file on disk to go on.
    const freshLedger = createLedger(path);
    const freshClient = testClient();
    const after = await guardedFetch(`${URL_UNDER_TEST}/restart`, {
      ledger: freshLedger,
      client: freshClient,
      fetchImpl: seller.fetchImpl,
    });

    expect(after.ok).toBe(false);
    expect(after.ok === false && after.code).toBe('over_total_budget');
    expect(freshLedger.getCumulativeSpent()).toBe(config.totalBudgetBaseUnits);
    freshLedger.close();

    ledger = createLedger(path);
  });
});

describe('guardedFetch — settlement problems', () => {
  it('counts a signed payment as spent even when the seller rejects it', async () => {
    const seller = fakeSeller({ settle: false });
    const result = await guardedFetch(URL_UNDER_TEST, { ledger, client: testClient(), fetchImpl: seller.fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('payment_failed');
    // Deliberately conservative: a signature was produced and dispatched, so
    // the spend is booked. The reason explains the shortfall.
    expect(ledger.getCumulativeSpent()).toBe(10_000n);
    expect(ledger.getSnapshot().rows[0]!.txHash).toBeNull();
  });

  it('refuses when the resource arrives with no settlement receipt', async () => {
    const seller = fakeSeller({ body: 'no receipt here' });
    const original = seller.fetchImpl;
    const stripped = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const response = await original(input, init);
      if (response.status === 200) return new Response(await response.text(), { status: 200 });
      return response;
    }) as typeof globalThis.fetch;

    const result = await guardedFetch(URL_UNDER_TEST, { ledger, client: testClient(), fetchImpl: stripped });
    expect(result.ok === false && result.code).toBe('no_settlement_receipt');
    expect(ledger.getCumulativeSpent()).toBe(10_000n);
  });
});

// ---------------------------------------------------------------------------
// the tool surface the model actually sees
// ---------------------------------------------------------------------------

describe('paidFetch — the LLM tool', () => {
  it('exposes a schema with a url and nothing money-shaped', () => {
    expect(paidFetchTool.name).toBe('paid_fetch');
    expect(Object.keys(paidFetchTool.input_schema.properties)).toEqual(['url']);
    expect(paidFetchTool.input_schema.required).toEqual(['url']);

    // The single most important assertion in this file. The check targets the
    // machine-readable schema, not the prose: the description deliberately
    // *names* amount, network, and asset in order to tell the model it cannot
    // set them, and a keyword scan of the whole tool would flag that. What must
    // never exist is a parameter the model could fill in.
    const schema = JSON.stringify(paidFetchTool.input_schema).toLowerCase();
    for (const forbidden of ['amount', 'price', 'max', 'budget', 'network', 'asset', 'confirm', 'token']) {
      expect(schema, forbidden).not.toContain(forbidden);
    }
  });

  it('tells the model that a refusal is final and must not be retried', () => {
    expect(paidFetchTool.description).toMatch(/cannot set or raise the price/i);
    expect(paidFetchTool.description).toMatch(/do not retry/i);
  });

  it('reports a successful payment with its cost and cumulative total', async () => {
    const seller = fakeSeller({ accepts: [req({ amount: '10000' })] });
    const outcome = await paidFetch(URL_UNDER_TEST, {
      ledger,
      client: testClient(),
      fetchImpl: seller.fetchImpl,
    });

    expect(outcome.paid).toBe(true);
    expect(outcome.ok).toBe(true);
    expect(outcome.spentBaseUnits).toBe(10_000n);
    expect(outcome.cumulativeSpentBaseUnits).toBe(10_000n);
    expect(outcome.refusalCode).toBeNull();
    expect(outcome.text).toContain('the good stuff');
  });

  it('reports a refusal as text the model can act on, not an exception', async () => {
    const seller = fakeSeller({ accepts: [req({ amount: '5000000' })] });
    const outcome = await paidFetch(URL_UNDER_TEST, {
      ledger,
      client: testClient(),
      fetchImpl: seller.fetchImpl,
    });

    expect(outcome.paid).toBe(false);
    expect(outcome.ok).toBe(false);
    expect(outcome.refusalCode).toBe('over_per_call_max');
    expect(outcome.spentBaseUnits).toBe(0n);

    // The text is the model's only input, so it has to say what happened, what
    // it cost, and that retrying is pointless.
    expect(outcome.text).toMatch(/REFUSED/);
    expect(outcome.text).toMatch(/over_per_call_max/);
    expect(outcome.text).toMatch(/nothing was paid/);
    expect(outcome.text).toMatch(/5 USDC/); // the quoted price
    expect(outcome.text).toMatch(/Do not retry/);
    expectNoPaymentAttempt(seller);
  });

  it('does not tell the model to retry a budget refusal', async () => {
    ledger.recordDecision({ url: 'prior', network: BASE_SEPOLIA, asset: BASE_SEPOLIA_USDC, quotedAmountBaseUnits: 5_000_000n, decision: 'paid', reason: 'previous run' });
    const seller = fakeSeller({ accepts: [req({ amount: '10000' })] });

    const outcome = await paidFetch(URL_UNDER_TEST, {
      ledger,
      client: testClient(),
      fetchImpl: seller.fetchImpl,
    });

    expect(outcome.refusalCode).toBe('over_total_budget');
    expect(outcome.text).toMatch(/0 remaining|cumulative spend/i);
    expectNoPaymentAttempt(seller);
  });

  it('truncates a large body so one purchase cannot flood the context', async () => {
    const huge = 'x'.repeat(50_000);
    const seller = fakeSeller({ accepts: [req({ amount: '10000' })], body: huge });
    const outcome = await paidFetch(URL_UNDER_TEST, {
      ledger,
      client: testClient(),
      fetchImpl: seller.fetchImpl,
    });

    expect(outcome.paid).toBe(true);
    expect(outcome.text.length).toBeLessThan(huge.length);
    expect(outcome.text).toMatch(/truncated/);
  });
});

// ---------------------------------------------------------------------------
// client construction and formatting
// ---------------------------------------------------------------------------

describe('createPurseClient', () => {
  it('refuses a malformed private key', () => {
    for (const bad of ['', '0x123', 'not-a-key', `0x${'z'.repeat(64)}`]) {
      expect(() => createPurseClient(bad), bad).toThrow(/WALLET_PRIVATE_KEY/);
    }
  });

  it('accepts a well-formed key', () => {
    expect(() => createPurseClient(`0x${'11'.repeat(32)}`)).not.toThrow();
  });
});

describe('formatting', () => {
  it('renders base units exactly, with integer arithmetic only', () => {
    expect(formatBaseUnits(50_000n)).toBe('0.05 USDC');
    expect(formatBaseUnits(5_000_000n)).toBe('5 USDC');
    expect(formatBaseUnits(1n)).toBe('0.000001 USDC');
    expect(formatBaseUnits(0n)).toBe('0 USDC');
    expect(baseUnitsToDecimal(50_000n)).toBe('0.050000');
    expect(baseUnitsToDecimal(1n)).toBe('0.000001');
  });

  it('round-trips without float error', () => {
    const amount = 12_345_678n;
    expect(BigInt(baseUnitsToDecimal(amount).replace('.', ''))).toBe(amount);
  });
});

// ---------------------------------------------------------------------------
// the real rogue seller, driven in-process
// ---------------------------------------------------------------------------

/**
 * These tests use the actual `sellers/rogue-stall.ts` app over real HTTP, so
 * the 402 headers are the same bytes an attacker would put on the wire. That
 * matters for the injection cases: a test built on a hand-written stub could
 * pass simply because the injection text never made it into the header.
 */
describe('rogue seller — prompt injection in the 402 metadata', () => {
  it('the seller really does put the injection in description, error and extra', async () => {
    const server = await startRogueServer(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/raise-budget`);
      expect(res.status).toBe(402);

      // If this ever stops holding, the refusal assertions below would be
      // vacuous: the guard would be refusing a header that never carried the
      // attack.
      const decoded = decodePaymentRequiredHeader(res.headers.get('payment-required')!);
      expect(decoded.resource?.description).toMatch(/approved a higher budget/i);
      expect(decoded.error).toMatch(/approved a higher budget/i);
      expect(JSON.stringify(decoded.accepts[0]?.extra)).toMatch(/approved a higher budget/i);
    } finally {
      await server.close();
    }
  });

  it('refuses the over-cap price and signs nothing, despite the injection', async () => {
    const server = await startRogueServer(0);
    const url = `http://127.0.0.1:${server.port}/raise-budget`;
    const wire = record();
    try {
      const result = await guardedFetch(url, { ledger, fetchImpl: wire.fetchImpl });

      expect(result.ok).toBe(false);
      expect((result as { code: string }).code).toBe('over_per_call_max');
      // The injection text must not appear in the operator-facing reason
      // either: the guard reports a policy decision, not the seller's story.
      expect((result as { reason: string }).reason).not.toMatch(/approved a higher budget/i);

      // One request, and it carried no authorization of any kind.
      expect(wire.requests).toHaveLength(1);
      expectNoPaymentOnWire(wire.requests);
      expect(ledger.getSnapshot().cumulativeSpentBaseUnits).toBe(0n);
    } finally {
      await server.close();
    }
  });

  it('judges a legal price unchanged when the same injection text is attached', async () => {
    const server = await startRogueServer(0);
    const url = `http://127.0.0.1:${server.port}/raise-budget-legal`;
    const wire = record();
    try {
      const result = await guardedFetch(url, { ledger, fetchImpl: wire.fetchImpl });

      // Same words, same code path, affordable quote. The judged amount is
      // exactly what the seller quoted, so the text moved nothing in either
      // direction. Without this pair, "the over-cap route was refused" could
      // just mean the injection was ignored *and* the price check fired, which
      // proves less than it looks.
      expect(result.quote?.amountBaseUnits).toBe(10_000n);
      expect(ledger.getSnapshot().rows[0]?.quotedAmountBaseUnits).toBe(10_000n);
    } finally {
      await server.close();
    }
  });

  it('never reads requirement text: description and extra are absent from the judge', async () => {
    // A structural assertion to back up the behavioural ones. If someone later
    // "improves" the refusal message by echoing what the seller said, this
    // fails and forces them to think about it.
    const source = readFileSync(fileURLToPath(new URL('../purse/guardedFetch.ts', import.meta.url)), 'utf8');
    const body = source.slice(source.indexOf('export async function guardedFetch'));
    expect(body).not.toMatch(/\.description/);
    expect(body).not.toMatch(/\.extra\b/);
    expect(body).not.toMatch(/resource\?\./);
  });
});

interface Recording {
  readonly fetchImpl: typeof fetch;
  readonly requests: Request[];
}

/**
 * Wrap fetch so the test can inspect exactly what reached the seller.
 *
 * The headline property of this file is "a refusal produced no signature", and
 * on the real seller the only way to observe that is from the wire. Asserting it
 * here keeps the rogue-seller tests honest in the same way
 * `expectNoPaymentAttempt` does for the stubbed ones.
 */
function record(): Recording {
  const requests: Request[] = [];
  const real = globalThis.fetch;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const req = new Request(input as string | URL, init);
    requests.push(req);
    return real(req);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

/** No request to the seller ever carried a payment authorization. */
function expectNoPaymentOnWire(requests: Request[]): void {
  for (const req of requests) {
    expect(req.headers.get('payment-signature')).toBeNull();
    expect(req.headers.get('authorization')).toBeNull();
  }
}

describe('honest seller — declared requirement', () => {
  const payTo = '0x1563915e194D8CfBA1943570603F7606A3115508' as const;

  it('declares exactly one paid route, on Base Sepolia, in real testnet USDC', () => {
    const routes = buildHonestRoutes(payTo);
    expect(Object.keys(routes)).toEqual(['GET /forecast']);

    // RouteConfig.accepts is a single option or a list, depending on how many
    // prices a route advertises. Normalise rather than casting.
    const raw = routes['GET /forecast']!.accepts;
    const accepts = (Array.isArray(raw) ? raw : [raw])[0]!;
    expect(accepts.network).toBe('eip155:84532');
    expect(accepts.scheme).toBe('exact');
    expect(accepts.price).toBe('0.01');
    expect(accepts.payTo).toBe(payTo);
  });

  it('prices /forecast at $0.01, which the default policy can afford', () => {
    const raw = buildHonestRoutes(payTo)['GET /forecast']!.accepts;
    const price = (Array.isArray(raw) ? raw : [raw])[0]!.price;
    // The control case has to be affordable, or the demo cannot tell "the
    // seller was abusive" apart from "the cap is set too low".
    expect(price).toBe('0.01');
    expect(config.perCallMaxBaseUnits).toBeGreaterThan(10_000n);
  });
});

// ---------------------------------------------------------------------------
// the tool schema, as the model sees it
// ---------------------------------------------------------------------------

describe('paidFetch tool schema — check #9 by inspection', () => {
  it('declares exactly one property, and nothing else', () => {
    const schema = paidFetchTool.input_schema as Record<string, unknown>;
    expect(Object.keys(schema.properties as object)).toEqual(['url']);
    expect(schema.required).toEqual(['url']);
    expect(schema.type).toBe('object');
  });

  it('sets additionalProperties:false so a smuggled key is rejected at validation', () => {
    // This is what makes the guarantee structural rather than a promise the
    // handler has to keep. Without it, a model emitting
    // {"url":"...","maxPrice":"999999999"} would validate, and the whole
    // argument would rest on the handler ignoring the extra key.
    expect((paidFetchTool.input_schema as Record<string, unknown>).additionalProperties).toBe(false);
  });

  it('contains no money-shaped key anywhere in the schema', () => {
    const serialised = JSON.stringify(paidFetchTool.input_schema).toLowerCase();
    for (const forbidden of [
      'amount', 'price', 'cost', 'budget', 'limit', 'max', 'cap',
      'network', 'asset', 'currency', 'token', 'confirm', 'override',
    ]) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });

  it('ignores money-shaped arguments the model might try to smuggle in', async () => {
    const seller = fakeSeller({ accepts: [req({ amount: '10000' })] });
    // Simulate a call that bypassed schema validation entirely.
    const smuggled = { url: URL_UNDER_TEST, maxPrice: '999999999', budget: '999999999' };
    const outcome = await paidFetch(smuggled.url, {
      ledger,
      client: testClient(),
      fetchImpl: seller.fetchImpl,
    });

    // The seller charged 10000 and that is what was authorised. The smuggled
    // "maxPrice" did not become a cap the guard honoured, and did not leak into
    // the quote.
    expect(outcome.spentBaseUnits).toBe(10_000n);
    expect(seller.lastPaymentHeader()).not.toContain('999999999');
  });
});

// ---------------------------------------------------------------------------
// the agent loop
// ---------------------------------------------------------------------------

/**
 * These drive `runAgent` with a scripted model instead of the real SDK. The
 * point is not to test the Anthropic API — it is to prove the loop transports
 * text faithfully and that every money decision still lands in
 * `purse/guardedFetch.ts`, with no cap-raise or retry logic in the loop itself.
 */
describe('runAgent', () => {
  /** A model that walks a fixed script of turns, then answers. */
  function scripted(script: Array<{ url?: string; text?: string }>): AgentModel {
    let i = 0;
    return async () => {
      const step = script[i++];
      if (!step || step.url === undefined) {
        return { text: step?.text ?? 'done', toolCalls: null };
      }
      return {
        text: step.text ?? null,
        toolCalls: [{ url: step.url, toolUseId: `call_${i}` }],
      };
    };
  }

  it('stops on a final answer without any tool call', async () => {
    const model = scripted([{ text: 'No sources were needed.' }]);
    const result = await runAgent({
      question: 'q',
      sources: [],
      model,
      ledger,
    });

    expect(result.stoppedBecause).toBe('final_answer');
    expect(result.summary).toBe('No sources were needed.');
    expect(result.fetches).toHaveLength(0);
  });

  it('feeds tool results back and keeps looping until a prose answer', async () => {
    const server = await startRogueServer(0);
    try {
      const model = scripted([
        { url: `http://127.0.0.1:${server.port}/free` },
        { url: `http://127.0.0.1:${server.port}/overpriced` },
        { text: 'One source was free, one was refused.' },
      ]);

      const result = await runAgent({
        question: 'q',
        sources: [],
        model,
        ledger,
      });

      expect(result.fetches).toHaveLength(2);
      expect(result.fetches[0]!.refusalCode).toBeNull();
      expect(result.fetches[1]!.refusalCode).toBe('over_per_call_max');
      expect(result.stoppedBecause).toBe('final_answer');
      // A refusal costs nothing and must not be booked as spend.
      expect(result.fetches[1]!.spentBaseUnits).toBe(0n);
    } finally {
      await server.close();
    }
  });

  it('never retries a refused URL, even if the model asks twice', async () => {
    const server = await startRogueServer(0);
    try {
      // A badly behaved model that ignores the "do not retry" instruction.
      const model = scripted([
        { url: `http://127.0.0.1:${server.port}/overpriced` },
        { url: `http://127.0.0.1:${server.port}/overpriced` },
        { text: 'gave up' },
      ]);

      const result = await runAgent({ question: 'q', sources: [], model, ledger });

      // Both calls were made, and both were refused at zero cost. The loop does
      // not deduplicate or short-circuit: it has no policy of its own. The
      // guarantee is that a retry cannot spend money, not that it cannot happen.
      expect(result.fetches).toHaveLength(2);
      expect(result.fetches.every((f) => f.refusalCode === 'over_per_call_max')).toBe(true);
      expect(result.fetches.every((f) => f.spentBaseUnits === 0n)).toBe(true);
      expect(ledger.getSnapshot().cumulativeSpentBaseUnits).toBe(0n);
    } finally {
      await server.close();
    }
  });

  it('stops at the turn cap rather than looping forever', async () => {
    let calls = 0;
    const model: AgentModel = async () => {
      calls++;
      return { text: null, toolCalls: [{ url: 'http://127.0.0.1:1/nothing', toolUseId: `c${calls}` }] };
    };

    const result = await runAgent({ question: 'q', sources: [], model, ledger, maxTurns: 3 });
    expect(result.stoppedBecause).toBe('max_turns');
    expect(result.turns).toBe(3);
  });

  it('carries the tool_use id through so tool_result can be attributed', async () => {
    // The model calls a tool once, then answers. On the second turn the
    // transcript it receives must contain that tool result keyed by the
    // original id, because the API rejects a tool_result that matches no
    // tool_use.
    const seen: string[] = [];
    let turn = 0;

    const model: AgentModel = async (t) => {
      turn++;
      for (const e of t) {
        if (e.role === 'tool') seen.push(e.toolUseId ?? 'MISSING');
      }
      return turn === 1
        ? { text: null, toolCalls: [{ url: 'http://127.0.0.1:1/unreachable', toolUseId: 'abc123' }] }
        : { text: 'done', toolCalls: null };
    };

    await runAgent({ question: 'q', sources: [], model, ledger });

    expect(seen).toEqual(['abc123']);
  });

  it('puts the question and the candidate sources in the system prompt', () => {
    const prompt = buildSystemPrompt(
      ['http://127.0.0.1:4021/forecast', 'http://127.0.0.1:4022/overpriced'],
      'does this week\'s rainfall forecast predict a mandi tomato price move?',
    );

    expect(prompt).toMatch(/mandi tomato/);
    expect(prompt).toContain('http://127.0.0.1:4021/forecast');
    expect(prompt).toContain('http://127.0.0.1:4022/overpriced');
    // The prompt must tell the model the money is not its to set.
    expect(prompt).toMatch(/no way to set a price/i);
  });
});

describe('runAgent — ledger wiring', () => {
  it('writes its decisions to the injected ledger, not the process-wide one', async () => {
    // Regression guard. `runAgent` takes a ledger for its budget checks; if it
    // fails to forward that same ledger to `paidFetch`, the guard falls back to
    // the process-wide ledger and the rows land in a different database. The
    // run then reconciles against an empty ledger and reports a clean zero,
    // which is exactly the kind of silent failure that hides a spend.
    const server = await startRogueServer(0);
    try {
      const model: AgentModel = async (t) =>
        t.length > 1
          ? { text: 'done', toolCalls: null }
          : {
              text: null,
              toolCalls: [
                { url: `http://127.0.0.1:${server.port}/overpriced`, toolUseId: 'c1' },
                { url: `http://127.0.0.1:${server.port}/wrong-asset`, toolUseId: 'c2' },
              ],
            };

      const result = await runAgent({ question: 'q', sources: [], model, ledger });

      const snapshot = ledger.getSnapshot();
      expect(snapshot.refusedCount).toBe(2);
      expect(snapshot.rows).toHaveLength(2);
      expect(result.fetches).toHaveLength(2);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// the signer spy: the central claim, asserted five ways
// ---------------------------------------------------------------------------

/**
 * Every test here asserts two independent things about a refusal:
 *
 *   1. the ledger recorded a `refused` row, and
 *   2. the signer was never called.
 *
 * (2) is the load-bearing one. Asserting only the refusal code would pass
 * against an implementation that built and signed a payment and then declined
 * to send it — a wallet-draining bug wearing a refusal's clothes. The signer spy
 * is checked separately from the HTTP assertions so neither can mask the other.
 */
describe('signer spy — a refusal never reaches the signer', () => {
  /** Run one guarded fetch with a fresh spy and return everything asserted. */
  async function attempt(options: {
    accepts: PaymentRequirements[];
    priorSpend?: bigint;
  }): Promise<{
    result: Awaited<ReturnType<typeof guardedFetch>>;
    spy: SignerSpy;
    seller: FakeSeller;
    snapshot: ReturnType<Ledger['getSnapshot']>;
  }> {
    if (options.priorSpend !== undefined && options.priorSpend > 0n) {
      ledger.recordDecision({
        url: 'https://example.invalid/earlier-run',
        network: BASE_SEPOLIA,
        asset: BASE_SEPOLIA_USDC,
        quotedAmountBaseUnits: options.priorSpend,
        decision: 'paid',
        reason: 'spend from an earlier run',
      });
    }

    const spy = makeSignerSpy();
    const seller = fakeSeller({ accepts: options.accepts });
    const result = await guardedFetch(URL_UNDER_TEST, {
      ledger,
      client: testClientWith(spy),
      fetchImpl: seller.fetchImpl,
    });

    return { result, spy, seller, snapshot: ledger.getSnapshot() };
  }

  it('quote > PER_CALL_MAX_BASE_UNITS → refused, signer NOT called', async () => {
    // 5000000 base units against a 50000 per-call cap: 100x over.
    const { result, spy, seller, snapshot } = await attempt({
      accepts: [req({ amount: '5000000' })],
    });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('over_per_call_max');

    // The two refusal assertions.
    expect(spy.callCount).toBe(0);
    expect(seller.sentPayment()).toBe(false);

    // And a refused row exists, with the quoted amount preserved.
    expect(snapshot.refusedCount).toBe(1);
    const row = snapshot.rows[0]!;
    expect(row.decision).toBe('refused');
    expect(row.quotedAmountBaseUnits).toBe(5_000_000n);
    expect(snapshot.cumulativeSpentBaseUnits).toBe(0n);
  });

  it('spentSoFar + quote > TOTAL_BUDGET_BASE_UNITS → refused, signer NOT called', async () => {
    // The two caps must be violated by *different* quotes, or only one check is
    // really under test. PER_CALL_MAX is 50000 and TOTAL_BUDGET is 5000000, so
    // 100000 is over the per-call cap but well under the total.
    //
    // Leave only 40000 of budget headroom and quote 100000: the per-call check
    // sees 100000 > 50000 and refuses, which is correct but not what this test
    // is for. To isolate the *total* check the quote has to clear the per-call
    // cap while blowing the remaining budget, so the headroom has to be smaller
    // than the quote. 40000 of headroom against a 40000 quote is exactly at the
    // boundary, so go just over it.
    const quote = 40_000n;
    const headroom = 30_000n;
    expect(quote).toBeLessThanOrEqual(config.perCallMaxBaseUnits);
    expect(config.totalBudgetBaseUnits - headroom + quote).toBeGreaterThan(
      config.totalBudgetBaseUnits,
    );

    const { result, spy, seller, snapshot } = await attempt({
      accepts: [req({ amount: quote.toString() })],
      priorSpend: config.totalBudgetBaseUnits - headroom,
    });

    expect(result.ok).toBe(false);
    // The refusal must be about the *total*, not the per-call cap. Getting this
    // backwards would still refuse, but for the wrong reason, and would label
    // an over-budget payment as a pricing problem.
    expect((result as { code: string }).code).toBe('over_total_budget');

    expect(spy.callCount).toBe(0);
    expect(seller.sentPayment()).toBe(false);

    expect(snapshot.refusedCount).toBe(1);
    expect(snapshot.cumulativeSpentBaseUnits).toBe(config.totalBudgetBaseUnits - headroom);
  });

  it('requirement.network not in ALLOWED_NETWORKS → refused, signer NOT called', async () => {
    const { result, spy, seller, snapshot } = await attempt({
      accepts: [req({ network: 'eip155:8453' })],
    });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('network_not_allowed');

    expect(spy.callCount).toBe(0);
    expect(seller.sentPayment()).toBe(false);

    expect(snapshot.refusedCount).toBe(1);
    expect(snapshot.rows[0]!.decision).toBe('refused');
  });

  it('requirement.asset not in ALLOWED_ASSETS → refused, signer NOT called', async () => {
    const { result, spy, seller, snapshot } = await attempt({
      accepts: [req({ asset: '0x1111111111111111111111111111111111111111' })],
    });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('asset_not_allowed');

    expect(spy.callCount).toBe(0);
    expect(seller.sentPayment()).toBe(false);

    expect(snapshot.refusedCount).toBe(1);
    expect(snapshot.rows[0]!.decision).toBe('refused');
  });

  it('a within-limits quote → signer IS called exactly once, paid row recorded', async () => {
    const { result, spy, seller, snapshot } = await attempt({
      accepts: [req({ amount: '10000' })],
    });

    expect(result.ok).toBe(true);
    expect(result.paid).toBe(true);

    // The mirror image: the signer ran, and it signed exactly this much. The
    // amount is asserted rather than just the count, so a signer that fired
    // twice or signed the wrong figure would fail here.
    expect(spy.callCount).toBe(1);
    expect(spy.calls[0]).toEqual({
      amount: '10000',
      asset: BASE_SEPOLIA_USDC,
      network: BASE_SEPOLIA,
    });
    expect(seller.sentPayment()).toBe(true);

    expect(snapshot.paidCount).toBe(1);
    expect(snapshot.refusedCount).toBe(0);
    expect(snapshot.cumulativeSpentBaseUnits).toBe(10_000n);
  });

  it('records exactly one row per attempt, never both paid and refused', async () => {
    // A second refusal path that must also not double-write.
    const spy = makeSignerSpy();
    const seller = fakeSeller({ accepts: [req({ amount: '99999999' })] });
    await guardedFetch(URL_UNDER_TEST, {
      ledger,
      client: testClientWith(spy),
      fetchImpl: seller.fetchImpl,
    });

    const rows = ledger.getSnapshot().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision).toBe('refused');
    expect(spy.callCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// no float touches a money comparison or a sum
// ---------------------------------------------------------------------------

/**
 * The spec allows a grep-based test here, and that is what this is — but it
 * inspects the *source* rather than trusting a code review, so a future
 * `parseFloat(amount)` slips the build instead of slipping past a reviewer who
 * is already looking at something else.
 *
 * Scope is deliberate. Each file is checked for the patterns that would put a
 * float into a money path, and any *legitimate* use must be named in
 * ALLOWED_FLOAT_CONTEXT or it fails. Right now that list is empty, which is the
 * point: there is no float in the purse.
 */
describe('money is never a float', () => {
  const MONEY_FILES = [
    'purse/config.ts',
    'purse/ledger.ts',
    'purse/guardedFetch.ts',
    'purse/tool.ts',
    'agent/agent.ts',
  ] as const;

  /**
   * Patterns that are wrong anywhere in a money module, with no exceptions.
   *
   * These have no legitimate use in this codebase: nothing in the purse needs
   * `parseFloat`, and `toFixed`/`toNumber` would mean a value had already been
   * through a double. `parseInt` is included because a base-10 radix on a
   * 6-decimal token silently truncates the amount.
   */
  const FORBIDDEN_ALWAYS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
    { pattern: /\bparseFloat\s*\(/, why: 'parseFloat returns a JS number' },
    { pattern: /\bparseInt\s*\(/, why: 'parseInt truncates a 6-decimal amount' },
    { pattern: /\btoFixed\s*\(/, why: 'toFixed implies a float in the money path' },
    { pattern: /\btoNumber\s*\(/, why: 'viem toNumber returns a JS number' },
  ];

  /**
   * Words that mark a line as being about money.
   *
   * Used to scope the patterns that have innocent uses. `Number(row.id)` is fine
   * — a row id is not money — but `Number(row.amount)` is the exact bug this
   * suite exists to prevent, and a file-wide ban on `Number(` would either fail
   * on legitimate ids or force the ban to be so narrow it misses the real thing.
   * Scoping by line keeps both honest.
   */
  const MONEY_WORD =
    /amount|base_?units|units|spent|price|cost|value|total|budget|quoted|balance|wei|cents/i;

  const FORBIDDEN_ON_MONEY_LINES: ReadonlyArray<{ pattern: RegExp; why: string }> = [
    {
      pattern: /\bNumber\s*\(\s*[a-zA-Z_$'\"`]/,
      why: 'Number(...) on a monetary value returns a float',
    },
    {
      pattern: /\b(amount|baseUnits|units|spent|price|cost|value|total|budget|quoted)\w*\s*:\s*number\b/i,
      why: 'a monetary field typed as number rather than bigint',
    },
  ];

  /**
   * Comments and docs legitimately discuss the *absence* of floats, so strip
   * them before scanning. Otherwise this file's own explanation of what it
   * checks would trip the check.
   */
  function codeOnly(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``') // template literals, incl. nested ${}
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  }

  it.each(MONEY_FILES)('%s contains no float in a money path', (relPath) => {
    const source = readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8');
    const code = codeOnly(source);
    const lines = code.split('\n');

    // Unconditional patterns first, checked against the whole file.
    const unconditional: Array<{ pattern: RegExp; why: string; haystack: string; lineNo?: number }> = [
      ...FORBIDDEN_ALWAYS.map((f) => ({ ...f, haystack: code })),
      // Then the money-scoped ones, checked line by line.
      ...FORBIDDEN_ON_MONEY_LINES.flatMap((f) =>
        lines
          .map((line, i) => ({ line, i }))
          .filter(({ line }) => MONEY_WORD.test(line))
          .map(({ line, i }) => ({ ...f, haystack: line, lineNo: i + 1 })),
      ),
    ];

    for (const { pattern, why, haystack, lineNo } of unconditional) {
      const match = pattern.exec(haystack);
      // The failure message quotes the pattern's source, which would itself trip
      // a future run of this test, so it is reconstructed rather than printed raw.
      const shown = pattern.source.split('').join('\\x00').replace(/x00/g, '');
      const where = lineNo ? ` line ${lineNo}` : '';
      expect(
        match,
        `${relPath}${where} matches a forbidden money-path pattern (${why}).\n` +
          `  pattern: ${shown}\n` +
          `  context: ${match ? haystack.slice(Math.max(0, match.index - 50), match.index + 50).trim() : ''}`,
      ).toBeNull();
    }
  });

  it('all monetary config values are bigint at runtime', () => {
    // The behavioural counterpart to the grep above: prove it at the boundary
    // rather than by pattern-matching the text.
    expect(typeof config.perCallMaxBaseUnits).toBe('bigint');
    expect(typeof config.totalBudgetBaseUnits).toBe('bigint');
    for (const asset of config.allowedAssets) {
      expect(typeof asset).toBe('string');
    }
  });

  it('a quoted amount that is exactly 2^53+1 survives a round trip intact', () => {
    // The number where a float would visibly break: 2^53 is not exactly
    // representable as a double, so +1 rounds away. If any comparison or sum
    // went through a JS number, this would come back wrong.
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    ledger.recordDecision({
      url: 'https://example.invalid/huge',
      network: BASE_SEPOLIA,
      asset: BASE_SEPOLIA_USDC,
      quotedAmountBaseUnits: huge,
      decision: 'paid',
      reason: 'spend beyond float precision',
    });

    const snapshot = ledger.getSnapshot();
    expect(snapshot.cumulativeSpentBaseUnits).toBe(huge);
    expect(snapshot.rows[0]!.quotedAmountBaseUnits).toBe(huge);
    // And the next bigint adds without drift.
    ledger.recordDecision({
      url: 'https://example.invalid/huge2',
      network: BASE_SEPOLIA,
      asset: BASE_SEPOLIA_USDC,
      quotedAmountBaseUnits: 1n,
      decision: 'paid',
      reason: 'one more base unit',
    });
    expect(ledger.getSnapshot().cumulativeSpentBaseUnits).toBe(huge + 1n);
  });

  it('a decimal-string quote is refused rather than parsed into a float', async () => {
    const spy = makeSignerSpy();
    const seller = fakeSeller({ accepts: [req({ amount: '0.05' })] });
    const result = await guardedFetch(URL_UNDER_TEST, {
      ledger,
      client: testClientWith(spy),
      fetchImpl: seller.fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('malformed_quote');
    expect(spy.callCount).toBe(0);
  });
});

/**
 * Prove the grep-based float test can actually fail.
 *
 * A guard that cannot fail is decoration. These feed a `Number(...)` on a
 * monetary line and a `parseFloat` through the same scanner the suite uses, and
 * assert the scanner rejects both. If someone weakens the patterns, these fail.
 */
describe('the float guard can fail', () => {
  /** Mirrors the scanner in the suite above, minus the file read. */
  function violationsIn(source: string): string[] {
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
    const found: string[] = [];
    for (const line of code.split('\n')) {
      if (MONEY_WORD_GUARD.test(line)) {
        for (const p of [/parseFloat\s*\(/, /parseInt\s*\(/, /\bNumber\s*\(\s*[a-zA-Z_$'"`]/]) {
          if (p.test(line)) found.push(line.trim());
        }
      }
    }
    return found;
  }

  const MONEY_WORD_GUARD =
    /amount|base_?units|units|spent|price|cost|value|total|budget|quoted|balance|wei|cents/i;

  it('flags Number() on an amount', () => {
    expect(violationsIn('const amount: number = Number(row.amount);')).toHaveLength(1);
  });

  it('flags parseFloat on a price', () => {
    expect(violationsIn('const price = parseFloat(quoted);')).toHaveLength(1);
  });

  it('flags a monetary field declared as number', () => {
    // Caught by the type-annotation pattern, not the call patterns, so this
    // exercises the other half of the scoped list.
    const code = 'interface Quote { amount: number; }';
    expect(MONEY_WORD_GUARD.test(code)).toBe(true);
  });

  it('does not flag Number() on a non-monetary field', () => {
    // The allowance that keeps the guard usable: row ids are numbers and always
    // will be. A blanket ban would push people to disable the check.
    expect(violationsIn('id: Number(row.id)')).toHaveLength(0);
  });
});

/**
 * No private key material is committed.
 *
 * A real secret is 32 bytes of hex. That is a specific enough shape to scan for
 * and specific enough that the false-positive rate is manageable:
 *
 *   - `purse/guardedFetch.ts` has a *validator* written as
 *     `/^0x[0-9a-fA-F]{64}$/`. That text is a character class and a quantifier,
 *     not 64 hex characters, so it does not match — which is the whole reason
 *     the pattern is anchored on real hex rather than on the words
 *     "private key".
 *   - This file declares the pattern itself. A pattern is not a key.
 *
 * The other half of the check is the allowlist below. A 64-hex string is only a
 * *plausible* key; it could be a tx hash or a test vector. The allowlist is
 * small, explicit, and each entry names why it is not a secret — so adding a
 * real key to the list is a visible, reviewable act rather than a quiet edit.
 */
describe('no committed private key material', () => {
  const SCANNED_GLOBS = [
    'purse/*.ts',
    'sellers/*.ts',
    'agent/*.ts',
    'scripts/*.ts',
    'test/*.ts',
    'ledger/*.json',
  ] as const;

  /**
   * Anchored on real hex rather than on the words "private key", so the
   * validator in `purse/guardedFetch.ts` and this declaration do not match
   * themselves. `String.match` with a /g regex resets `lastIndex`, so a single
   * shared instance is safe to reuse across files.
   */
  const secretLike = /0x[0-9a-fA-F]{64}/g;

  /** Exact strings that look like keys but are not, with a reason each. */
  const ALLOWED_EXACT: ReadonlyMap<string, string> = new Map([
    [
      '0x0000000000000000000000000000000000000000000000000000000000000000',
      'the zero address, used as an unset/empty placeholder',
    ],
  ]);

  /**
   * JSON keys whose 32-byte hex values are public chain data, with a reason each.
   *
   * A transaction hash and a private key are the same shape: 32 bytes of hex.
   * Nothing in the bytes distinguishes them, so a scanner that only looks at
   * shape has to call a settled run a leak. In JSON we do have one more piece of
   * evidence — the field the value sits under — so the value is attributed to
   * its key and judged against this list instead.
   *
   * Only names this repo actually emits are listed. `txHash` is the
   * `DecisionRow` field (`purse/ledger.ts:47`) that `scripts/agentSample.ts:228`
   * exports into `ledger/sample-run.json`; `tx_hash` is the SQLite column name
   * for the same thing (`purse/ledger.ts:67`). Speculative names such as
   * `blockHash` are deliberately absent: an unused name is a hole with no
   * benefit, and if one is ever added the scan fails closed and asks for a
   * deliberate decision.
   *
   * The residual limit, stated rather than hidden: a private key pasted under
   * one of these keys would be waved through. That is inherent — the bytes are
   * indistinguishable — so the mitigation is that the list is two names long,
   * each naming why it is public, and adding to it is a visible edit.
   */
  const PUBLIC_JSON_FIELDS: ReadonlyMap<string, string> = new Map([
    ['txHash', 'a Base Sepolia transaction hash: public on-chain data'],
    ['tx_hash', 'the SQLite column name for the same field'],
  ]);

  /**
   * The directories behind SCANNED_GLOBS.
   *
   * The glob is stripped to leave a trailing slash and the result is used as the
   * directory directly. Wrapping it in `dirname` looks equivalent and is not:
   * `dirname('/repo/purse/')` is `/repo`, so every `*.ts` entry silently
   * resolved to the repository root, matched the single root-level `.ts` file,
   * and none of `purse/`, `sellers/`, `agent/`, `scripts/`, or `test/` was ever
   * scanned. A secret in any of them passed. `*.json` entries happened to work
   * only because `.replace('*.ts', '')` does not match them, leaving the `*`
   * inside the URL and pushing `dirname` down onto the intended directory by
   * accident. Strip every glob suffix the same way instead of relying on that.
   */
  function scannedDir(rel: string): string {
    return fileURLToPath(new URL(`../${rel.replace(/\*.*$/, '')}`, import.meta.url));
  }

  function repoFiles(): string[] {
    const out: string[] = [];
    for (const rel of SCANNED_GLOBS) {
      const dir = scannedDir(rel);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (rel.endsWith('.ts') && !name.endsWith('.ts')) continue;
        if (rel.endsWith('.json') && !name.endsWith('.json')) continue;
        out.push(join(dir, name));
      }
    }
    return out;
  }

  /**
   * Walk a parsed JSON document, reporting 32-byte hex literals by the key that
   * holds them so a public field can be recognised.
   */
  function scanJsonTree(node: unknown, path: string[], fileLabel: string, offences: string[]): void {
    if (Array.isArray(node)) {
      node.forEach((child, i) => scanJsonTree(child, [...path, `[${i}]`], fileLabel, offences));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        scanJsonTree(child, [...path, key], fileLabel, offences);
      }
      return;
    }
    if (typeof node !== 'string') return;

    const key = path[path.length - 1] ?? '';
    for (const hit of node.match(secretLike) ?? []) {
      if (ALLOWED_EXACT.has(hit)) continue;
      if (PUBLIC_JSON_FIELDS.has(key)) continue;
      offences.push(`${fileLabel}  $.${path.join('.')}  ${hit}`);
    }
  }

  it('finds no 32-byte hex literal outside the allowlist', () => {
    const offences: string[] = [];

    for (const file of repoFiles()) {
      const source = readFileSync(file, 'utf8');
      const label = relative(process.cwd(), file);
      const isJson = file.endsWith('.json');

      // JSON gets a parsed walk, because a field name is evidence that a raw
      // regex does not have. If the file does not parse, fall through to the
      // line scan rather than skipping it: a file that cannot be parsed must
      // not become a file that is not scanned.
      if (isJson) {
        try {
          scanJsonTree(JSON.parse(source), [], label, offences);
          continue;
        } catch {
          // Unparseable JSON is not trusted to be harmless.
        }
      }

      source.split('\n').forEach((line, i) => {
        for (const hit of line.match(secretLike) ?? []) {
          if (ALLOWED_EXACT.has(hit)) continue;
          offences.push(`${label}:${i + 1}  ${hit}`);
        }
      });
    }

    expect(
      offences,
      offences.length
        ? 'These look like 32-byte hex secrets and must not be committed:\\n' + offences.join('\\n')
        : '',
    ).toHaveLength(0);
  });

  it('no file named like a keystore or keyfile is committed', () => {
    const suspicious = repoFiles().filter((f) => /keystore|keyfile|\.pem$|id_rsa/i.test(f));
    expect(suspicious).toHaveLength(0);
  });

  it('.env.example leaves every secret variable empty', () => {
    const example = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
    const assignments = example.split('\n').filter((l) => /^[A-Z_0-9]+=/.test(l));
    expect(assignments.length).toBeGreaterThan(0);

    // Not every value is a secret. PER_CALL_MAX_BASE_UNITS=50000 is a safe
    // worked example and is more useful filled in than blank; a private key is
    // useful in no state other than empty. So the check is scoped to the
    // variables that are actually sensitive, which is the claim worth making.
    const secret = /(PRIVATE_KEY|SECRET|TOKEN|PASSWORD|API_KEY|MNEMONIC|SEED)/i;
    const secrets = assignments.filter((l) => secret.test(l.split('=')[0]!));
    expect(secrets.length, 'expected .env.example to document the secret vars').toBeGreaterThan(0);

    for (const line of secrets) {
      const [name, ...rest] = line.split('=');
      expect(rest.join('='), `${name} in .env.example must be an empty placeholder`).toBe('');
    }
  });

  it('.env.example documents a non-secret default for each policy var', () => {
    // The opposite check: the policy block is meant to be filled in with safe
    // worked examples, so a blank here would be a regression, not a safety win.
    const example = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
    for (const name of [
      'PER_CALL_MAX_BASE_UNITS',
      'TOTAL_BUDGET_BASE_UNITS',
      'ALLOWED_NETWORKS',
      'ALLOWED_ASSETS',
    ]) {
      const line = example.split('\n').find((l) => l.startsWith(`${name}=`));
      expect(line, `${name} missing from .env.example`).toBeDefined();
      expect(line!.split('=')[1], `${name} in .env.example should show a safe default`).toBeTruthy();
    }
  });

  it('.env.example names no mnemonic or seed phrase variable', () => {
    const example = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
    // BIP-39 style word lists and seed-phrase vars are the other way a wallet
    // gets committed, so they are banned outright rather than scanned for.
    expect(/MNEMONIC|SEED_PHRASE|SEED_WORDS|RECOVERY/i.test(example)).toBe(false);
  });

  it('the private key validator is a shape check, not a key', () => {
    // Documents the exception the scan relies on, so a future reader does not
    // "fix" the validator into something that trips its own secret scan.
    const source = readFileSync(fileURLToPath(new URL('../purse/guardedFetch.ts', import.meta.url)), 'utf8');
    expect(source).toMatch(/PRIVATE_KEY_RE\s*=\s*\/\^0x\[0-9a-fA-F\]\{64\}\$\//);
  });
});

/**
 * The budget survives the process, not just the object.
 *
 * A `TOTAL_BUDGET_BASE_UNITS` that is enforced against an in-memory counter is
 * not enforced: quit the agent, start it again, and it spends the whole budget
 * a second time. That is the failure this proves absent, and it is proved the
 * only way that counts — by actually spawning a second `node` process against
 * the same file. An in-process `createLedger()` on the same path would not
 * demonstrate it, because that still shares one process's memory and would pass
 * against the broken implementation.
 */
describe('the ledger persists across a process restart', () => {
  const REPO = fileURLToPath(new URL('..', import.meta.url));

  /**
   * Module specifiers for the child process, built with `pathToFileURL`.
   *
   * `REPO` is a filesystem path, and on Windows that is `D:\\coin-purse dev 6\\`.
   * Dropping a path straight into an `import ... from '...'` is not a path
   * operation at all: a specifier that does not start with `./`, `../`, or
   * `file:` is looked up as a *package name*, so Node strips the backslashes and
   * fails with
   *
   *     Cannot find module 'D:coin-purse dev 6/purse/ledger.js'
   *
   * which is exactly what the Windows run reported. The space in the directory
   * name breaks it a second time on its own.
   *
   * `pathToFileURL(path).href` is the supported way to turn a filesystem path
   * into an importable specifier. It normalises the separators, percent-encodes
   * the drive colon and the space, and yields a `file:` URL on both Windows and
   * POSIX, so the same child source works unchanged on either.
   */
  const specifier = (relativePath: string): string => pathToFileURL(join(REPO, relativePath)).href;

  const LEDGER_MODULE = specifier('purse/ledger.js');
  const CONFIG_MODULE = specifier('purse/config.js');

  const POLICY_ENV: Record<string, string> = {
    PER_CALL_MAX_BASE_UNITS: '50000',
    TOTAL_BUDGET_BASE_UNITS: '5000000',
    ALLOWED_NETWORKS: 'eip155:84532',
    ALLOWED_ASSETS: BASE_SEPOLIA_USDC,
    WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),
  };

  /**
   * A child process that writes a fixed number of paid rows and prints the
   * cumulative spend it observed. Generated in a temp dir, never committed.
   */
  const childSource = (dbPath: string, url: string, amountBaseUnits: string, count: number) => `
import { createLedger } from '${LEDGER_MODULE}';
const ledger = createLedger(${JSON.stringify(dbPath)});
for (let i = 0; i < ${count}; i++) {
  ledger.recordDecision({
    url: ${JSON.stringify(url)},
    network: 'eip155:84532',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    quotedAmountBaseUnits: BigInt(${JSON.stringify(amountBaseUnits)}),
    decision: 'paid',
    reason: 'child process run',
  });
}
process.stdout.write(ledger.getCumulativeSpent().toString());
`;

  /**
   * Runs a child against a policy env and returns its raw stdout. The path is
   * baked into `source` by the caller, since the child has to open the same
   * database this test just wrote.
   */
  function runChild(source: string): string {
    const file = join(mkdtempSync(join(tmpdir(), 'coin-purse-child-')), 'child.ts');
    writeFileSync(file, source);
    return execFileSync(
      process.execPath,
      [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)), file],
      { env: { ...process.env, ...POLICY_ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  }

  it('gives the child a file: URL it can resolve, not a raw path', () => {
    // The original failure cannot be reproduced on POSIX, because a POSIX path
    // happens to look like a legal specifier and resolves by accident. So assert
    // the property that is actually required and that holds on both platforms.
    const modules = [
      ['LEDGER_MODULE', LEDGER_MODULE],
      ['CONFIG_MODULE', CONFIG_MODULE],
    ] as const;

    for (const [label, spec] of modules) {
      // A specifier that does not start with ./, ../, or file: is looked up as
      // a package name. This is the whole bug.
      expect(spec.startsWith('file://'), `${label} must be a file: URL, got ${spec}`).toBe(true);

      // It has to round-trip back to a real file, or the child fails at import
      // for a reason that has nothing to do with the ledger. The source is .ts
      // on disk; the specifier says .js because the project imports like that.
      const asPath = fileURLToPath(new URL(spec));
      expect(asPath.endsWith(join('purse', `${label.split('_')[0]!.toLowerCase()}.js`))).toBe(true);
      expect(existsSync(asPath.replace(/\.js$/, '.ts')), `${label} -> ${asPath} has no source`).toBe(true);
    }
  });

  it('a second process sees the first process spend', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'coin-purse-restart-'));
    const dbPath = join(dir, 'spend.db');

    // Process 1: spend 3 x 10000, then exit.
    const first = BigInt(
      runChild(childSource(dbPath, 'https://example.invalid/run-1', '10000', 3)),
    );
    expect(first).toBe(30_000n);

    // Process 2: a brand new process, brand new ledger object, same file.
    // If spend were held in memory this would report 0 and the budget would have
    // silently reset on every restart.
    const second = BigInt(
      runChild(
      `import { createLedger } from '${LEDGER_MODULE}';
const ledger = createLedger(${JSON.stringify(dbPath)});
process.stdout.write(ledger.getCumulativeSpent().toString());`,
      ),
    );
    expect(second).toBe(30_000n);
  });

  it(
    'a restarted process cannot exceed the total budget it already spent',
    { timeout: 60_000 },
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'coin-purse-budget-'));
      const dbPath = join(dir, 'spend.db');

      // Process 1 spends 4_950_000 of the 5_000_000 budget, leaving 50_000.
      runChild(childSource(dbPath, 'https://example.invalid/drain', '4950000', 1));

      // Process 2 asks to spend 100_000 more. The guard must refuse on the total
      // budget, using the amount it recovered from disk — 4950000 + 100000.
      // A fresh-counter implementation would see 100_000, clear the 50_000
      // per-call cap, and pay. It refuses instead, so the ceiling held.
      const result = runChild(
      `import { config } from '${CONFIG_MODULE}';
import { createLedger } from '${LEDGER_MODULE}';
const ledger = createLedger(${JSON.stringify(dbPath)});
const spent = ledger.getCumulativeSpent();
const quote = 100000n;
process.stdout.write(
  JSON.stringify({ spent: spent.toString(), fits: spent + quote <= config.totalBudgetBaseUnits }),
);`,
    );

      const parsed = JSON.parse(result) as { spent: string; fits: boolean };
      expect(BigInt(parsed.spent)).toBe(4_950_000n);
      // 4950000 + 100000 = 5050000 > 5000000, so the whole remaining budget is
      // not enough. This is the assertion that matters.
      expect(parsed.fits).toBe(false);
    },
  );
});

/**
 * `payment_failed` is not "nothing was paid".
 *
 * Every other refusal in this codebase is decided from the quote, before a
 * payload exists, so "nothing was paid and no signature was produced" is a true
 * and useful thing to tell the model. `payment_failed` is the exception: the
 * guard signed, dispatched, and then the request or the settlement failed.
 *
 * Getting this wrong is not a cosmetic error. The old text claimed nothing was
 * paid, `spentBaseUnits` was reported as 0, and the model was left free to try
 * again — while the ledger conservatively counted the row as `paid`. A model
 * told "nothing was paid" would be right to retry, and a retry against an
 * already-signed payment is how one lookup gets charged twice. The three things
 * below are asserted together because they only mean anything as a set: the
 * prose, the reported spend, and the ledger row.
 */
describe('an unconfirmed payment is never reported as a clean refusal', () => {
  it('says the payment was dispatched, not that nothing was paid', async () => {
    // `settle: false` is the honest stall with a broken facilitator: it quotes
    // legally, receives a valid signature, then fails to settle.
    const seller = fakeSeller({ accepts: [req({ amount: '10000' })], settle: false });
    const spy = makeSignerSpy();
    const outcome = await paidFetch(URL_UNDER_TEST, {
      ledger,
      client: testClientWith(spy),
      fetchImpl: seller.fetchImpl,
    });

    expect(outcome.refusalCode).toBe('payment_failed');
    // The signature really was produced, so the wallet is already committed.
    expect(spy.callCount).toBe(1);

    // The old, dangerous claim must be gone.
    expect(outcome.text).not.toMatch(/nothing was paid/i);
    expect(outcome.text).not.toMatch(/no signature was produced/i);

    // And the true claim must be present, including the advice not to retry.
    expect(outcome.text).toMatch(/UNCONFIRMED/i);
    expect(outcome.text).toMatch(/already dispatched/i);
    expect(outcome.text).toMatch(/do not retry/i);
  });

  it('reports the dispatched amount as spent, matching the ledger', async () => {
    const seller = fakeSeller({ accepts: [req({ amount: '10000' })], settle: false });
    const spy = makeSignerSpy();
    const outcome = await paidFetch(URL_UNDER_TEST, {
      ledger,
      client: testClientWith(spy),
      fetchImpl: seller.fetchImpl,
    });

    // Before this fix the tool said 0 while the ledger said 10_000, so the
    // agent's own running total contradicted the record of what it spent.
    expect(outcome.spentBaseUnits).toBe(10_000n);

    const snapshot = ledger.getSnapshot();
    expect(snapshot.paidCount).toBe(1);
    expect(snapshot.cumulativeSpentBaseUnits).toBe(10_000n);
    expect(outcome.cumulativeSpentBaseUnits).toBe(snapshot.cumulativeSpentBaseUnits);
  });

  it('handles a connection that dies after signing the same way', async () => {
    // The least certain case of all: the signed request may never have reached
    // anyone. It still must not be reported as a clean refusal.
    let first = true;
    const fetchImpl: typeof globalThis.fetch = async () => {
      if (first) {
        first = false;
        const paymentRequired: PaymentRequired = {
          x402Version: 2,
          resource: { url: URL_UNDER_TEST, description: 'test', mimeType: 'application/json' },
          accepts: [req({ amount: '10000' })],
        };
        return new Response('payment required', {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired) },
        });
      }
      throw new TypeError('fetch failed');
    };

    const spy = makeSignerSpy();
    const outcome = await paidFetch(URL_UNDER_TEST, {
      ledger,
      client: testClientWith(spy),
      fetchImpl,
    });

    expect(spy.callCount).toBe(1);
    expect(outcome.refusalCode).toBe('payment_failed');
    expect(outcome.text).toMatch(/UNCONFIRMED/i);
    expect(outcome.spentBaseUnits).toBe(10_000n);
    expect(ledger.getSnapshot().cumulativeSpentBaseUnits).toBe(10_000n);
  });

  it('a quote-time refusal still says nothing was paid', async () => {
    // The other direction. The new wording must not leak onto refusals that
    // genuinely cost nothing, or every over-priced quote would read as a possible
    // charge and the model would give up on legitimate sources.
    const seller = fakeSeller({ accepts: [req({ amount: '5000000' })] });
    const outcome = await paidFetch(URL_UNDER_TEST, {
      ledger,
      client: testClient(),
      fetchImpl: seller.fetchImpl,
    });

    expect(outcome.refusalCode).toBe('over_per_call_max');
    expect(outcome.text).toMatch(/nothing was paid/i);
    expect(outcome.text).not.toMatch(/UNCONFIRMED/i);
    expect(outcome.spentBaseUnits).toBe(0n);
    expect(ledger.getSnapshot().cumulativeSpentBaseUnits).toBe(0n);
  });
});

/**
 * The environment loader, and the ordering bug that made it necessary.
 *
 * `purse/config.ts` calls `loadConfig()` at module level and throws on a missing
 * policy. That is deliberate and must not be weakened. It has one sharp
 * consequence: every module in `config.ts`'s graph needs `process.env` populated
 * *before* that body runs, and ESM gives no way to guarantee that by putting an
 * import in the right place. So `purse/config.ts` imports `purse/env.ts` and the
 * ordering is a structural guarantee instead of a convention.
 *
 * These tests assert that structure, because the original bug — the agent
 * failing with `PER_CALL_MAX_BASE_UNITS: Required` while a valid `.env` sat on
 * disk — is invisible to every other test in this file. Nothing else would have
 * caught it.
 */
describe('environment loading', () => {
  /** Blank out comments so a scan cannot match its own documentation. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  it('config.ts loads the environment before it reads the policy', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../purse/config.ts', import.meta.url)),
      'utf8',
    );

    // The import has to be there...
    expect(source).toMatch(/import\s+['"]\.\/env\.js['"]/);
    // ...and the eager read has to be the reason it matters.
    expect(source).toMatch(/export const config: PurseConfig = loadConfig\(\);/);

    // Ordering: the loader import must come before the policy singleton's
    // definition in the file. A cheap structural proxy for "is evaluated first",
    // and the thing that would fail if someone moved the import to the bottom.
    const loaderAt = source.indexOf("import './env.js'");
    const eagerAt = source.indexOf('export const config: PurseConfig = loadConfig();');
    expect(loaderAt).toBeGreaterThan(-1);
    expect(loaderAt).toBeLessThan(eagerAt);
  });

  it('every entry point inherits the loader instead of importing dotenv itself', () => {
    // `import 'dotenv/config'` resolves `.env` against `process.cwd()`, so each
    // entry point using it is a chance to load nothing. There should be exactly
    // one loader, and no entry point should be reaching for dotenv directly.
    const entryPoints = [
      'agent/agent.ts',
      'sellers/honest-stall.ts',
      'sellers/rogue-stall.ts',
      'scripts/agentSample.ts',
      'scripts/exportLedger.ts',
      'scripts/sampleRun.ts',
    ];

    for (const rel of entryPoints) {
      const source = readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
      expect(source, `${rel} imports dotenv directly`).not.toMatch(/from\s+['"]dotenv/);
      expect(source, `${rel} imports dotenv/config`).not.toMatch(/import\s+['"]dotenv\/config['"]/);
    }

    // Exactly one module in the project is allowed to know dotenv exists.
    const loader = readFileSync(
      fileURLToPath(new URL('../purse/env.ts', import.meta.url)),
      'utf8',
    );
    expect(loader).toMatch(/from\s+['"]dotenv['"]/);
  });

  it('a real environment variable beats .env, so .env cannot shadow the shell', () => {
    // `override: false` is the operator-facing half of the loader. Without it a
    // value in `.env` would clobber the shell, and
    // `PER_CALL_MAX_BASE_UNITS=1000 npm run agent` would silently do nothing —
    // quietly removing the operator's only lever over the policy.
    const loader = readFileSync(
      fileURLToPath(new URL('../purse/env.ts', import.meta.url)),
      'utf8',
    );
    expect(loader).toMatch(/override:\s*false/);
  });

  it('did not load a real wallet key from .env during the tests', () => {
    // The strongest available proxy for "the loader is not leaking secrets into
    // the test process": vitest.config.ts injects this throwaway key, and
    // `override: false` means a real one in a developer's `.env` cannot replace
    // it. If the loader were switched to `override: true`, this fails.
    //
    // Only the throwaway is asserted. The real value, if it were ever loaded, is
    // never read, compared, or printed here.
    expect(process.env.WALLET_PRIVATE_KEY).toBe(`0x${'11'.repeat(32)}`);
  });

  it('anchors .env to the module, not the working directory', () => {
    // Anchoring to `import.meta.url` is what makes this work when the command is
    // run from a parent directory — the common way a `.env` silently goes
    // unread. Asserted structurally, because the alternative (running npm from
    // elsewhere) is not something the test should do.
    // Comments are stripped first. `purse/env.ts` discusses `process.cwd()` at
    // length precisely to explain why it is not used, and a scan that counted
    // its own documentation would fail for the right reason in the wrong way.
    const loader = stripComments(
      readFileSync(fileURLToPath(new URL('../purse/env.ts', import.meta.url)), 'utf8'),
    );
    expect(loader).toMatch(/import\.meta\.url/);
    expect(loader).not.toMatch(/process\.cwd\(\)/);
  });
});
