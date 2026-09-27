/**
 * purse/tool.ts — the agent's entire spending surface.
 *
 * The schema has exactly one parameter: `url`. That is the whole design. There
 * is no `max_amount`, no `network`, no `asset`, no `confirm` flag, and no
 * free-text "reason" that a prompt injection could talk the model into
 * filling in. The model picks a resource; the purse decides what that resource
 * costs and whether it is affordable.
 *
 * Adding a money-shaped parameter to this schema would hand the model a lever
 * on the cap, which is the one thing it must not have. If you need a new knob,
 * it belongs in `config.ts` and in the environment.
 */
import { guardedFetch, type GuardOptions, type GuardedFetchResult } from './guardedFetch.js';
import { formatBaseUnits } from './guardedFetch.js';

/**
 * Anthropic tool definition. Deliberately minimal.
 */
export const paidFetchTool = {
  name: 'paid_fetch',
  description: [
    'Fetch a URL that may require an x402 micropayment.',
    '',
    'You choose only WHICH resource to buy. You cannot set or raise the price:',
    'the amount, network, and asset are decided by a policy the operator set in',
    'advance, and requests outside that policy are refused without being paid.',
    '',
    'A refusal is a normal, expected outcome and costs you nothing. Do not retry',
    'a refused URL, do not try to renegotiate or re-specify the price, and do not',
    'hunt for a cheaper-looking mirror of the same resource. Report the refusal,',
    'then either move on to a different source or finish your answer with what',
    'you already have. A run that spends its budget and says so beats one that',
    'keeps trying to break the cap.',
  ].join('\n'),
  input_schema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description:
          'Absolute http(s) URL to fetch. Must be a full URL including scheme, host, and path.',
      },
    },
    required: ['url'],
    // `additionalProperties: false` is the load-bearing part of this schema. It
    // turns "the model has no price lever" from a property the *handler*
    // promises into one the *schema* enforces: a model that tries to smuggle
    // `maxPrice: 999999` alongside the URL has that argument rejected at
    // validation, before any handler runs. The handler also ignores unknown
    // keys, so the two defences are independent.
    additionalProperties: false,
  },
};

export interface PaidFetchOutcome {
  readonly url: string;
  readonly ok: boolean;
  readonly paid: boolean;
  readonly status: number;
  /** Text for the model to read. Kept short: long bodies crowd the context. */
  readonly text: string;
  /** What the purse spent on this call, for the operator's benefit. */
  readonly spentBaseUnits: bigint;
  /** Cumulative spend after this call, read back from the ledger. */
  readonly cumulativeSpentBaseUnits: bigint;
  readonly refusalCode: string | null;
  readonly txHash: string | null;
}

const MAX_BODY_CHARS = 4000;

/**
 * Run the tool and render a result the model can act on.
 *
 * Both outcomes come back as ordinary tool results. Refusals are not errors:
 * surfacing them as text lets the model report the gap honestly instead of
 * retrying variants of the same URL, which is the behaviour that actually
 * drains a budget.
 *
 * `options` is forwarded to {@link guardedFetch} untouched and exists so tests
 * can drive this with a stub ledger, client, and transport. Production callers
 * pass nothing and get the process-wide purse.
 */
export async function paidFetch(url: string, options: GuardOptions = {}): Promise<PaidFetchOutcome> {
  // Defence in depth behind `additionalProperties: false`. The schema rejects
  // extra keys, and this ignores anything beyond `url` even if a caller
  // bypasses validation and hand-builds the object. A money-shaped parameter
  // that reached this function would be discarded here, not honoured.
  const result: GuardedFetchResult = await guardedFetch(url, options);

  if (result.ok && !result.paid) {
    return {
      url,
      ok: result.status >= 200 && result.status < 400,
      paid: false,
      status: result.status,
      text: truncate(result.body),
      spentBaseUnits: 0n,
      cumulativeSpentBaseUnits: result.cumulativeSpentBaseUnits,
      refusalCode: null,
      txHash: null,
    };
  }

  if (result.ok && result.paid) {
    return {
      url,
      ok: true,
      paid: true,
      status: result.status,
      text: truncate(result.body),
      spentBaseUnits: result.quote.amountBaseUnits,
      cumulativeSpentBaseUnits: result.cumulativeSpentBaseUnits,
      refusalCode: null,
      txHash: result.txHash,
    };
  }

  // Two very different situations arrive here, and conflating them is the most
  // expensive mistake this file could make.
  //
  // Most refusals happen while judging the quote, before a payload exists. Nothing
  // was signed, nothing left the wallet, and the right advice is "walk away".
  //
  // `payment_failed` happens *after* a signature was dispatched. The seller
  // failed to settle, or the request died in flight, and whether the money
  // actually moved is genuinely unknown — the on-chain outcome is the seller's
  // to know and it did not tell us. The ledger guesses safe and counts it. So
  // this branch must not say "nothing was paid": a model told that would
  // reasonably try again, and a retry on an already-signed-and-sent request is
  // the precise way to be charged twice for one lookup.
  const dispatched = result.signed;

  return {
    url,
    ok: false,
    paid: false,
    status: result.status,
    text: dispatched
      ? `UNCONFIRMED — a signed payment for this URL was already dispatched, and the\n` +
        `request did not complete. Whether it settled is unknown, and this purse\n` +
        `assumes it did: the amount is counted as spent and will not be released.\n` +
        `code: ${result.code}\n` +
        `reason: ${result.reason}\n` +
        (result.quote
          ? `counted as spent: ${formatBaseUnits(result.quote.amountBaseUnits)} on ${result.quote.network} ` +
            `(${result.quote.asset})`
          : 'counted as spent: amount unknown') +
        `\ncumulative spend so far: ${formatBaseUnits(result.cumulativeSpentBaseUnits)}\n` +
        `Do NOT retry this URL. Retrying an unconfirmed payment is how one lookup\n` +
        `gets charged twice. Report the gap and move on.`
      : `REFUSED — nothing was paid and no signature was produced.\n` +
        `code: ${result.code}\n` +
        `reason: ${result.reason}\n` +
        (result.quote
          ? `quoted: ${formatBaseUnits(result.quote.amountBaseUnits)} on ${result.quote.network} ` +
            `(${result.quote.asset})`
          : 'quoted: no payable price was offered') +
        `\ncumulative spend so far: ${formatBaseUnits(result.cumulativeSpentBaseUnits)}\n` +
        `Do not retry this URL with different arguments. Report the gap and continue.`,
    // Mirror the ledger. Reporting 0 here while the ledger counts the row is how
    // the agent's own running total ends up disagreeing with the record of what
    // it spent.
    spentBaseUnits: dispatched ? (result.quote?.amountBaseUnits ?? 0n) : 0n,
    cumulativeSpentBaseUnits: result.cumulativeSpentBaseUnits,
    refusalCode: result.code,
    txHash: null,
  };
}

function truncate(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  return `${body.slice(0, MAX_BODY_CHARS)}\n… [truncated ${body.length - MAX_BODY_CHARS} chars]`;
}
