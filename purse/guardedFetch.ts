/**
 * purse/guardedFetch.ts — the policy engine.
 *
 * This is the only code in the repository that can cause money to move, and it
 * has one job: decide, from the ledger and the frozen config alone, whether a
 * specific quoted price is payable. The LLM chooses *what* to fetch. It has no
 * way to express *how much*, and even if it could, this function would ignore
 * it.
 *
 * The flow is deliberately three-phase rather than a single wrapped fetch:
 *
 *   1. QUOTE   — plain GET, expect 402, read the `PAYMENT-REQUIRED` header.
 *                No signature is produced and nothing is committed.
 *   2. JUDGE   — evaluate the quote against the policy and the running ledger
 *                total. Record the decision, paid or refused, before signing.
 *   3. SETTLE  — only if allowed: sign a payment, re-request, back-fill the tx
 *                hash. Verify that what we signed is what we judged.
 *
 * Splitting quote from pay is the whole point. A wrapper that discovers the
 * price and pays in one step has already signed by the time it knows the
 * number, so no policy check can be trusted to have run first.
 */
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';
import { config, type PurseConfig } from './config.js';
import { getLedger, type Ledger } from './ledger.js';

export type RefusalCode =
  | 'request_failed'
  | 'no_payment_required'
  | 'no_acceptable_option'
  | 'network_not_allowed'
  | 'asset_not_allowed'
  | 'scheme_not_allowed'
  | 'malformed_quote'
  | 'over_per_call_max'
  | 'over_total_budget'
  | 'signing_failed'
  | 'quote_mismatch'
  | 'payment_failed'
  | 'no_settlement_receipt';

export interface PolicyQuote {
  readonly network: string;
  readonly asset: string;
  readonly scheme: string;
  readonly amountBaseUnits: bigint;
  readonly payTo: string;
  readonly x402Version: number;
}

interface GuardedFetchCommon {
  readonly status: number;
  readonly body: string;
  readonly cumulativeSpentBaseUnits: bigint;
  readonly quote: PolicyQuote | null;
  readonly decisionId: number | null;
  /**
   * Did a signature leave the wallet before this result was produced?
   *
   * Everything else in this file can refuse without the wallet's involvement:
   * a judge runs on the quote before a payload exists, so no policy failure
   * above the dispatch point can have cost anything. Once a payload has been
   * signed and sent, that stops being true, and the answer is "we do not know".
   *
   * This flag is what lets the refusal path tell the truth. Without it,
   * `payment_failed` reports itself as "nothing was paid and no signature was
   * produced" — which is exactly backwards, and wrong in the direction that
   * invites a retry that spends again. The ledger already guesses the safe way
   * (count the row as `paid`); this carries the same truth to the caller.
   */
  readonly signed: boolean;
}

/**
 * A free endpoint answered. Nothing was quoted, so nothing was recorded.
 *
 * Note that `ok` here means "the purse reached a verdict", not "the request
 * succeeded": a 404 or a 500 from a free endpoint also lands here, because
 * there was no price to judge. Read `status` for the HTTP outcome. Callers that
 * want "did I get content" should test `status` themselves, which is what
 * `paidFetch` does.
 */
export interface GuardedFetchFree extends GuardedFetchCommon {
  readonly ok: true;
  readonly paid: false;
  readonly txHash: null;
}

/** A payment was authorised, dispatched, and accepted. */
export interface GuardedFetchPaid extends GuardedFetchCommon {
  readonly ok: true;
  readonly paid: true;
  readonly txHash: string | null;
  readonly quote: PolicyQuote;
  readonly decisionId: number;
}

/** The purse declined. `paid` is always false and no signature was produced. */
export interface GuardedFetchRefused extends GuardedFetchCommon {
  readonly ok: false;
  readonly paid: false;
  readonly code: RefusalCode;
  readonly reason: string;
}

export type GuardedFetchResult = GuardedFetchFree | GuardedFetchPaid | GuardedFetchRefused;

export interface GuardOptions {
  /** Injectable for tests. Defaults to the process-wide ledger. */
  readonly ledger?: Ledger;
  /** Injectable for tests. Defaults to the frozen environment policy. */
  readonly policy?: PurseConfig;
  /** Extra request headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Injectable fetch, for tests. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Injectable x402 client, for tests. */
  readonly client?: x402HTTPClient;
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Render base units as an exact decimal string using integer arithmetic only.
 * Used to hand the x402 library the same cap we enforce ourselves, so its
 * built-in spend controls and our policy cannot disagree.
 */
export function baseUnitsToDecimal(amount: bigint, decimals = 6): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = (abs % divisor).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/**
 * Choose the cheapest acceptable option rather than the first one.
 *
 * A seller that offers a free USDC option next to a $500 one must not be able
 * to steer us into the $500 by ordering. The x402 client applies this same
 * selector internally, so the option we judge is the option that gets signed.
 *
 * Exported because option selection *is* policy: it is part of the decision
 * that spends money, so it is tested directly rather than assumed.
 */
export function selectCheapest(_version: number, requirements: PaymentRequirements[]): PaymentRequirements {
  let best: PaymentRequirements | undefined;
  for (const requirement of requirements) {
    if (!/^\d+$/.test(requirement.amount)) continue;
    if (best === undefined || BigInt(requirement.amount) < BigInt(best.amount)) {
      best = requirement;
    }
  }
  if (!best) {
    throw new Error('no option with a well-formed integer amount');
  }
  return best;
}

/**
 * Build the x402 HTTP client used for quoting and paying.
 *
 * Three caps are layered here. Our ledger is authoritative; the other two are
 * independent, code-disjoint checks that fail closed:
 *
 *  - scheme registration is limited to `ALLOWED_NETWORKS`, so no other chain is
 *    even signable;
 *  - `spendControls` carries the same per-call cap and the same asset
 *    allowlist, so the library itself refuses a price we would have refused;
 *  - `judgeQuote` then re-checks both against the ledger total.
 */
export function createPurseClient(privateKey: string, policy: PurseConfig = config): x402HTTPClient {
  if (!PRIVATE_KEY_RE.test(privateKey)) {
    throw new Error(
      'guardedFetch: WALLET_PRIVATE_KEY must be 0x followed by 64 hex characters. ' +
        'Use a throwaway testnet key; never a key that holds real funds.',
    );
  }
  if (policy.allowedNetworks.length === 0) throw new Error('guardedFetch: policy allows no networks');
  if (policy.allowedAssets.length === 0) throw new Error('guardedFetch: policy allows no assets');

  const account = privateKeyToAccount(privateKey as `0x${string}`);

  let client = new x402Client(selectCheapest);
  for (const network of policy.allowedNetworks) {
    client = client.register(network as `eip155:${string}`, new ExactEvmScheme(account));
  }

  client = client.setSpendControls({
    maxAmountPerPayment: `${baseUnitsToDecimal(policy.perCallMaxBaseUnits)} USDC`,
    allowedAssets: policy.allowedNetworks.flatMap((network) =>
      policy.allowedAssets.map((asset) => ({
        network: network as `eip155:${string}`,
        asset: asset as `0x${string}`,
      })),
    ),
  });

  return new x402HTTPClient(client);
}

interface Judgement {
  readonly allowed: boolean;
  readonly code?: RefusalCode;
  readonly reason?: string;
}

/**
 * The policy, as a pure function of (quote, cumulative spend, config).
 *
 * Side-effect free on purpose: it can be tested exhaustively without a wallet,
 * a network, or a database, which is the only practical way to be confident
 * about the branch that decides whether real money moves.
 */
export function judgeQuote(
  requirement: PaymentRequirements,
  cumulativeSpent: bigint,
  policy: PurseConfig = config,
): Judgement {
  if (!policy.allowedNetworks.includes(requirement.network)) {
    return {
      allowed: false,
      code: 'network_not_allowed',
      reason: `network ${requirement.network} is not in ALLOWED_NETWORKS (${policy.allowedNetworks.join(', ')})`,
    };
  }

  if (!policy.allowedAssets.includes(requirement.asset.toLowerCase())) {
    return {
      allowed: false,
      code: 'asset_not_allowed',
      reason: `asset ${requirement.asset} is not in ALLOWED_ASSETS (${policy.allowedAssets.join(', ')})`,
    };
  }

  // `exact` authorises a known amount up front. A scheme that settles an
  // unknown amount ("upto") is refused regardless of price, because the whole
  // point of the cap is knowing the number in advance.
  if (requirement.scheme !== 'exact') {
    return {
      allowed: false,
      code: 'scheme_not_allowed',
      reason: `scheme ${requirement.scheme} is not permitted; only "exact" fixes the amount in advance`,
    };
  }

  if (!/^\d+$/.test(requirement.amount)) {
    return {
      allowed: false,
      code: 'malformed_quote',
      reason: `quoted amount ${JSON.stringify(requirement.amount)} is not a non-negative integer string`,
    };
  }

  const amount = BigInt(requirement.amount);

  if (amount === 0n) {
    return { allowed: false, code: 'malformed_quote', reason: 'quoted amount is zero' };
  }

  if (amount > policy.perCallMaxBaseUnits) {
    return {
      allowed: false,
      code: 'over_per_call_max',
      reason: `quoted ${amount} base units exceeds PER_CALL_MAX_BASE_UNITS (${policy.perCallMaxBaseUnits})`,
    };
  }

  const projected = cumulativeSpent + amount;
  if (projected > policy.totalBudgetBaseUnits) {
    return {
      allowed: false,
      code: 'over_total_budget',
      reason:
        `quoted ${amount} base units would bring cumulative spend to ${projected}, over ` +
        `TOTAL_BUDGET_BASE_UNITS (${policy.totalBudgetBaseUnits}); ` +
        `${cumulativeSpent} already spent, ${policy.totalBudgetBaseUnits - cumulativeSpent} remaining`,
    };
  }

  return { allowed: true };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch a URL, paying for it if and only if the policy allows.
 *
 * Does not throw for a refusal. A refusal is a normal outcome, reported as
 * `{ ok: false, paid: false }`; transport errors and malformed protocol
 * responses come back the same way, because an exception escaping into an
 * agent loop is a worse outcome than a recorded "we did not pay".
 */
export async function guardedFetch(url: string, options: GuardOptions = {}): Promise<GuardedFetchResult> {
  const ledger = options.ledger ?? getLedger();
  const policy = options.policy ?? config;
  const http = options.client ?? createPurseClient(process.env.WALLET_PRIVATE_KEY ?? '', policy);
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const baseHeaders: Record<string, string> = { ...options.headers };

  /** Build a refusal, recording it in the ledger when a price was on the table. */
  const refuse = (
    code: RefusalCode,
    reason: string,
    extra: {
      status?: number;
      body?: string;
      quote?: PolicyQuote | null;
      record?: boolean;
      decisionId?: number | null;
      /** True once a signed payload has been dispatched. See `signed` above. */
      signed?: boolean;
    } = {},
  ): GuardedFetchRefused => {
    const quote = extra.quote ?? null;
    let decisionId = extra.decisionId ?? null;
    if (extra.record && quote) {
      decisionId = ledger.recordDecision({
        url,
        network: quote.network,
        asset: quote.asset,
        quotedAmountBaseUnits: quote.amountBaseUnits,
        decision: 'refused',
        reason: `${code}: ${reason}`,
      }).id;
    }
    return {
      ok: false,
      paid: false,
      status: extra.status ?? 402,
      body: extra.body ?? '',
      code,
      reason,
      quote,
      decisionId,
      // Default to the pessimistic reading, but only where pessimism is
      // warranted. `record: true` means this call just wrote a *refused* row,
      // which is itself proof that nothing was dispatched. A `decisionId`
      // handed in from `reserved.id` means the opposite: a `paid` row was
      // reserved before dispatch and is being reused, so assume the worst
      // unless the site says otherwise. Over-reporting a possible spend is the
      // error that costs money; over-reporting it on every refusal is the error
      // that makes the field meaningless.
      signed: extra.signed ?? (extra.decisionId !== undefined && extra.decisionId !== null && !extra.record),
      cumulativeSpentBaseUnits: ledger.getCumulativeSpent(),
    };
  };

  // ---- Phase 1: QUOTE -----------------------------------------------------
  let quoted: Response;
  try {
    quoted = await doFetch(url, { headers: baseHeaders, redirect: 'error' });
  } catch (error) {
    return refuse('request_failed', `request failed before any quote was available: ${describe(error)}`, { status: 0 });
  }

  if (quoted.status !== 402) {
    // Free or errored endpoint. There is no price, so there is no decision to
    // record and nothing to authorise.
    const body = await quoted.text().catch(() => '');
    return {
      ok: true,
      paid: false,
      signed: false,
      status: quoted.status,
      body,
      quote: null,
      txHash: null,
      decisionId: null,
      cumulativeSpentBaseUnits: ledger.getCumulativeSpent(),
    };
  }

  let paymentRequired: PaymentRequired;
  try {
    paymentRequired = http.getPaymentRequiredResponse((name) => quoted.headers.get(name));
  } catch (error) {
    return refuse('malformed_quote', `402 carried no usable PAYMENT-REQUIRED header: ${describe(error)}`);
  }

  const accepts = paymentRequired.accepts ?? [];
  if (accepts.length === 0) {
    return refuse('no_acceptable_option', 'server answered 402 with an empty accepts list');
  }

  // The same selector the x402 client will use internally, so the option we
  // judge below is the option that actually gets signed.
  let requirement: PaymentRequirements;
  try {
    requirement = selectCheapest(paymentRequired.x402Version, accepts);
  } catch {
    // The selector skips options whose amount is not an integer string, so
    // landing here means nothing on offer was priceable. Distinguish "nothing
    // was offered" from "everything offered was malformed", because only the
    // second one is evidence of a broken or hostile seller.
    const allMalformed = accepts.every((a) => !/^\d+$/.test(a.amount));
    if (!allMalformed) {
      return refuse('no_acceptable_option', 'no offered option had a well-formed integer amount');
    }
    const raw = accepts[0]!.amount;
    // quoted_amount is a money column and refuses to hold a float, so the
    // unusable price is recorded as zero and preserved verbatim in the reason.
    const decisionId = ledger.recordDecision({
      url,
      network: accepts[0]!.network,
      asset: accepts[0]!.asset.toLowerCase(),
      quotedAmountBaseUnits: 0n,
      decision: 'refused',
      reason: `malformed_quote: quoted amount ${JSON.stringify(raw)} is not a non-negative integer string`,
    }).id;
    return {
      ok: false,
      paid: false,
      status: 402,
      body: '',
      code: 'malformed_quote',
      reason: `quoted amount ${JSON.stringify(raw)} is not a non-negative integer string`,
      quote: null,
      decisionId,
      // The 402 was rejected while being read. No payload was built, so nothing
      // was signed and nothing was sent.
      signed: false,
      cumulativeSpentBaseUnits: ledger.getCumulativeSpent(),
    };
  }

  let quote: PolicyQuote;
  try {
    quote = {
      network: requirement.network,
      asset: requirement.asset.toLowerCase(),
      scheme: requirement.scheme,
      amountBaseUnits: BigInt(requirement.amount),
      payTo: requirement.payTo,
      x402Version: paymentRequired.x402Version,
    };
  } catch (error) {
    return refuse('malformed_quote', `quoted amount was not an integer: ${describe(error)}`);
  }

  // ---- Phase 2: JUDGE -----------------------------------------------------
  // The running total is re-read from disk on every decision. This is the line
  // that makes the budget survive a restart.
  const spentBefore = ledger.getCumulativeSpent();
  const judgement = judgeQuote(requirement, spentBefore, policy);

  if (!judgement.allowed) {
    return refuse(judgement.code ?? 'no_acceptable_option', judgement.reason ?? 'refused', {
      quote,
      record: true,
    });
  }

  // Reserve the budget BEFORE signing. If the process dies mid-payment the row
  // already exists, so the spend is still counted when it comes back up.
  const reserved = ledger.recordDecision({
    url,
    network: quote.network,
    asset: quote.asset,
    quotedAmountBaseUnits: quote.amountBaseUnits,
    decision: 'paid',
    reason:
      `within policy: ${quote.amountBaseUnits} <= per-call ${policy.perCallMaxBaseUnits}; ` +
      `projected ${spentBefore + quote.amountBaseUnits} <= budget ${policy.totalBudgetBaseUnits}`,
  });

  // ---- Phase 3: SETTLE ----------------------------------------------------
  let payload;
  try {
    payload = await http.createPaymentPayload(paymentRequired);
  } catch (error) {
    // The reservation stands. A signed-but-undispatched payment is treated as
    // spent, because the alternative failure mode is real money moving
    // unrecorded.
    return refuse('signing_failed', `policy allowed this payment but signing failed: ${describe(error)}`, {
      quote,
      decisionId: reserved.id,
    });
  }

  // Independent confirmation that we are about to authorise the number we
  // judged. Guards against the selector drifting between quote and payload.
  const accepted = payload.accepted;
  if (
    accepted.amount !== quote.amountBaseUnits.toString() ||
    accepted.network !== quote.network ||
    accepted.asset.toLowerCase() !== quote.asset
  ) {
    return refuse(
      'quote_mismatch',
      `refusing to sign: judged ${quote.amountBaseUnits} on ${quote.network}/${quote.asset} ` +
        `but the payload authorises ${accepted.amount} on ${accepted.network}/${accepted.asset}`,
      // The payload was built in memory to compare against the quote, but it was
      // never sent, so nothing left the wallet here.
      { quote, decisionId: reserved.id, signed: false },
    );
  }

  let settled: Response;
  try {
    settled = await doFetch(url, {
      headers: { ...baseHeaders, ...http.encodePaymentSignatureHeader(payload) },
      redirect: 'error',
    });
  } catch (error) {
    return refuse('payment_failed', `payment was signed and dispatched but the request failed: ${describe(error)}`, {
      status: 0,
      quote,
      decisionId: reserved.id,
      signed: true,
    });
  }

  const body = await settled.text().catch(() => '');

  let receipt: SettleResponse | null = null;
  try {
    receipt = http.getPaymentSettleResponse((name) => settled.headers.get(name));
  } catch {
    receipt = null;
  }

  if (settled.status === 402 || (receipt !== null && receipt.success === false)) {
    return refuse('payment_failed', receipt?.errorReason ?? `seller rejected the payment (HTTP ${settled.status})`, {
      status: settled.status,
      body,
      quote,
      decisionId: reserved.id,
      signed: true,
    });
  }

  if (receipt?.success && receipt.transaction) {
    ledger.recordSettlement(reserved.id, receipt.transaction);
  } else if (!receipt) {
    return refuse(
      'no_settlement_receipt',
      'resource was returned but no PAYMENT-RESPONSE receipt came back, so settlement cannot be confirmed',
      { status: settled.status, body, quote, decisionId: reserved.id },
    );
  }

  return {
    ok: true,
    paid: true,
    signed: true,
    status: settled.status,
    body,
    quote,
    txHash: receipt?.transaction ?? null,
    decisionId: reserved.id,
    cumulativeSpentBaseUnits: ledger.getCumulativeSpent(),
  };
}

/**
 * Display formatting for logs and transcripts. Presentation only; it never
 * round-trips back into a payment amount.
 */
export function formatBaseUnits(amount: bigint, decimals = 6, symbol = 'USDC'): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = (abs % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''} ${symbol}`;
}
