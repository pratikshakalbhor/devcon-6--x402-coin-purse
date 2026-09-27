/**
 * scripts/sampleRun.ts — drive the real purse against the real rogue seller and
 * export the resulting ledger.
 *
 * This is a genuine end-to-end run, not a fixture: the seller really serves
 * hand-crafted 402 responses, the purse really fetches, really decodes the
 * `PAYMENT-REQUIRED` header, really evaluates the policy, and really writes to
 * SQLite. The only thing not exercised is on-chain settlement, which needs a
 * funded Base Sepolia wallet and a live facilitator. See the `notes` field in
 * the exported JSON.
 *
 *   npx tsx scripts/sampleRun.ts
 */
import '../purse/env.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { config } from '../purse/config.js';
import { createLedger } from '../purse/ledger.js';
import { formatBaseUnits, guardedFetch } from '../purse/guardedFetch.js';
import { startRogueServer } from '../sellers/rogue-stall.js';

const OUT = resolve('ledger/sample-run.json');

/** One hit per attack, then repeated /drain hits to approach the ceiling. */
const PLAN: Array<{ route: string; hits: number }> = [
  { route: '/free', hits: 1 },
  { route: '/overpriced', hits: 1 },
  { route: '/raise-budget', hits: 1 },
  { route: '/raise-budget-legal', hits: 1 },
  { route: '/wrong-network', hits: 1 },
  { route: '/wrong-asset', hits: 1 },
  { route: '/decimal-amount', hits: 1 },
  { route: '/no-eip712-domain', hits: 1 },
  { route: '/no-header', hits: 1 },
  { route: '/empty-accepts', hits: 1 },
  { route: '/cheap-then-ruinous', hits: 1 },
  { route: '/ruinous-then-cheap', hits: 1 },
  { route: '/upto-scheme', hits: 1 },
  { route: '/injection', hits: 1 },
  { route: '/drain', hits: 8 },
];

interface Attempt {
  readonly route: string;
  readonly url: string;
  readonly httpStatus: number;
  /** What happened to this fetch, as the agent would see it. */
  readonly outcome: 'free' | 'paid' | 'refused';
  readonly refusalCode: string | null;
  readonly reason: string;
  readonly quotedBaseUnits: string | null;
  /**
   * What the ledger booked. This differs from `outcome` whenever a payment was
   * authorised and dispatched but settlement could not be confirmed: the fetch
   * failed, yet the spend is still counted. See the notes.
   */
  readonly ledgerDecision: 'paid' | 'refused' | null;
  readonly settlementConfirmed: boolean;
  readonly cumulativeSpentBaseUnits: string;
  readonly txHash: string | null;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'coin-purse-sample-'));
  const ledger = createLedger(join(dir, 'sample.db'));
  const server = await startRogueServer(0);
  const base = `http://127.0.0.1:${server.port}`;

  console.log(`[sample] rogue seller listening on ${base}`);
  console.log(
    `[sample] policy: ${formatBaseUnits(config.perCallMaxBaseUnits)} per call, ` +
      `${formatBaseUnits(config.totalBudgetBaseUnits)} total, ${config.allowedNetworks.join(',')}`,
  );
  console.log('');

  const attempts: Attempt[] = [];

  for (const { route, hits } of PLAN) {
    for (let hit = 0; hit < hits; hit++) {
      const url = hits > 1 ? `${base}${route}?hit=${hit}` : `${base}${route}`;
      const before = ledger.getSnapshot().rows.length;
      const result = await guardedFetch(url, { ledger });
      const row = ledger.getSnapshot().rows[before];

      attempts.push({
        route,
        url,
        httpStatus: result.status,
        outcome: result.paid ? 'paid' : result.ok ? 'free' : 'refused',
        refusalCode: result.ok ? null : result.code,
        reason: result.ok
          ? result.paid
            ? 'paid and settled'
            : 'no payment required'
          : result.reason,
        quotedBaseUnits: result.quote ? result.quote.amountBaseUnits.toString() : null,
        ledgerDecision: row?.decision ?? null,
        settlementConfirmed: result.paid && result.txHash !== null,
        cumulativeSpentBaseUnits: result.cumulativeSpentBaseUnits.toString(),
        txHash: result.paid ? result.txHash : null,
      });

      const verdict = result.paid ? 'PAID' : result.ok ? 'FREE' : 'REFUSED';
      console.log(
        `[sample] ${route.padEnd(22)} ${verdict.padEnd(8)} ` +
          `${result.ok ? '' : (result as { code: string }).code}`,
      );
    }
  }

  const snapshot = ledger.getSnapshot();
  ledger.close();
  await server.close();

  const report = {
    generatedAt: new Date().toISOString(),
    seller: {
      drainSettles: server.drainEnabled,
      drainNote: server.drainEnabled
        ? '/drain and /injection are x402-protected and really settle.'
        : 'FACILITATOR_PRIVATE_KEY was not set, so /drain and /injection were served as free endpoints and no payment was attempted against them.',
    },
    policy: {
      perCallMaxBaseUnits: config.perCallMaxBaseUnits.toString(),
      perCallMaxFormatted: formatBaseUnits(config.perCallMaxBaseUnits),
      totalBudgetBaseUnits: config.totalBudgetBaseUnits.toString(),
      totalBudgetFormatted: formatBaseUnits(config.totalBudgetBaseUnits),
      allowedNetworks: config.allowedNetworks,
      allowedAssets: config.allowedAssets,
    },
    totals: {
      cumulativeSpentBaseUnits: snapshot.cumulativeSpentBaseUnits.toString(),
      cumulativeSpentFormatted: formatBaseUnits(snapshot.cumulativeSpentBaseUnits),
      paidCount: snapshot.paidCount,
      refusedCount: snapshot.refusedCount,
      withinBudget: snapshot.cumulativeSpentBaseUnits <= config.totalBudgetBaseUnits,
    },
    attempts,
    decisions: snapshot.rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      url: row.url,
      network: row.network,
      asset: row.asset,
      quotedAmountBaseUnits: row.quotedAmountBaseUnits.toString(),
      quotedAmountFormatted: formatBaseUnits(row.quotedAmountBaseUnits),
      decision: row.decision,
      reason: row.reason,
      txHash: row.txHash,
    })),
    notes: [
      'Every row here came from a real HTTP exchange with sellers/rogue-stall.ts and a real SQLite ledger.',
      'Read each attempt as one of four cases, because "refused" covers three genuinely different situations:',
      '  (1) outcome "free": the seller asked for no money, so there was no price to judge and nothing was recorded. ledgerDecision is null. This includes /drain and /injection, which would really settle if a facilitator key were set.',
      '  (2) outcome "refused" with ledgerDecision "refused": a real 402 quote that the policy declined. No signature was produced and no payment header was ever sent, so nothing could have moved. These are the /overpriced, /wrong-network, /wrong-asset, /decimal-amount, /raise-budget and /upto-scheme rows.',
      '  (3) outcome "refused" with ledgerDecision null: the seller sent a 402 the guard could not read a quote from at all (/no-header, /empty-accepts). No payment was attempted. There is also no ledger row, because there is no network, asset or amount to attribute one to, and inventing them would put false data in the audit trail. The refusal code is still reported per-attempt here.',
      '  (4) outcome "refused" with ledgerDecision "paid": the policy allowed the price, a signature was produced and dispatched, and the hand-rolled seller could not settle. A payment header WAS sent for these three.',
      'The spend is still booked in case (4), with txHash null, on purpose: a payment that might have moved money is counted, because the failure mode that loses funds is under-counting, not over-counting.',
      'The paid/settle path needs a funded Base Sepolia wallet and a live x402 facilitator, so on-chain settlement is not exercised in this run.',
      'It is covered instead by test/guardedFetch.test.ts, which drives the full quote-judge-pay path against a stubbed settlement.',
    ],
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  rmSync(dir, { recursive: true, force: true });

  console.log('');
  console.log(`[sample] spent    ${formatBaseUnits(snapshot.cumulativeSpentBaseUnits)} of ${formatBaseUnits(config.totalBudgetBaseUnits)}`);
  console.log(`[sample] paid     ${snapshot.paidCount}`);
  console.log(`[sample] refused  ${snapshot.refusedCount}`);
  console.log(`[sample] wrote    ${OUT}`);
}

await main();
