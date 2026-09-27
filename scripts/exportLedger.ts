/**
 * scripts/exportLedger.ts — dump a ledger as human-readable JSON.
 *
 *   npx tsx scripts/exportLedger.ts [path-to-db] [output.json]
 *
 * BigInt is stringified on the way out. JSON has no bigint, and silently
 * letting a total become a float is the exact failure this project exists to
 * prevent.
 */
import '../purse/env.js';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { config } from '../purse/config.js';
import { createLedger, getLedger } from '../purse/ledger.js';
import { formatBaseUnits } from '../purse/guardedFetch.js';

const [, , dbArg, outArg] = process.argv;

const ledger = dbArg ? createLedger(resolve(dbArg)) : getLedger();

try {
  const snapshot = ledger.getSnapshot();

  const report = {
    generatedAt: new Date().toISOString(),
    ledgerPath: ledger.path,
    policy: {
      perCallMaxBaseUnits: config.perCallMaxBaseUnits.toString(),
      totalBudgetBaseUnits: config.totalBudgetBaseUnits.toString(),
      allowedNetworks: config.allowedNetworks,
      allowedAssets: config.allowedAssets,
    },
    totals: {
      cumulativeSpentBaseUnits: snapshot.cumulativeSpentBaseUnits.toString(),
      cumulativeSpentFormatted: formatBaseUnits(snapshot.cumulativeSpentBaseUnits),
      remainingBaseUnits: (config.totalBudgetBaseUnits - snapshot.cumulativeSpentBaseUnits).toString(),
      remainingFormatted: formatBaseUnits(config.totalBudgetBaseUnits - snapshot.cumulativeSpentBaseUnits),
      paidCount: snapshot.paidCount,
      refusedCount: snapshot.refusedCount,
      withinBudget: snapshot.cumulativeSpentBaseUnits <= config.totalBudgetBaseUnits,
    },
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
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;

  if (outArg) {
    writeFileSync(resolve(outArg), json);
    console.log(`wrote ${resolve(outArg)}`);
  } else {
    process.stdout.write(json);
  }
} finally {
  if (dbArg) ledger.close();
}
