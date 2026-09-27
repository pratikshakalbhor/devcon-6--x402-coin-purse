/**
 * purse/ledger.ts — durable, append-only record of every payment decision.
 *
 * Design notes that matter for money:
 *
 *  - `quoted_amount` is TEXT holding a stringified BigInt. It is never REAL
 *    and never an INTEGER column, so no 64-bit overflow and no float rounding
 *    can ever corrupt a total.
 *  - `getCumulativeSpent()` re-reads the database on every call. The running
 *    total is a derived value, not a cached variable, so a fresh process picks
 *    up exactly where the last one stopped. Kill this process mid-run, start
 *    it again, and the budget still holds.
 *  - A 'paid' row is written BEFORE the payment is dispatched, with a NULL
 *    `tx_hash`, and back-filled once the transfer settles. A row that is
 *    written but never settled is counted as spent, because the failure mode
 *    we care about is "money left the purse and we did not notice", not "the
 *    ledger is one row pessimistic". Over-counting is the safe direction for
 *    a hard cap; under-counting is the one that loses real funds.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type Decision = 'paid' | 'refused';

export interface DecisionEntry {
  readonly url: string;
  readonly network: string;
  readonly asset: string;
  /** Price the server asked for, in base units. Required even when refused. */
  readonly quotedAmountBaseUnits: bigint;
  readonly decision: Decision;
  /** Human-readable justification. Recorded for both outcomes. */
  readonly reason: string;
  readonly txHash?: string | null;
}

export interface DecisionRow {
  readonly id: number;
  readonly ts: string;
  readonly url: string;
  readonly network: string;
  readonly asset: string;
  readonly quotedAmountBaseUnits: bigint;
  readonly decision: Decision;
  readonly reason: string;
  readonly txHash: string | null;
}

export interface LedgerSnapshot {
  readonly cumulativeSpentBaseUnits: bigint;
  readonly paidCount: number;
  readonly refusedCount: number;
  readonly rows: readonly DecisionRow[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT    NOT NULL,
  url            TEXT    NOT NULL,
  network        TEXT    NOT NULL,
  asset          TEXT    NOT NULL,
  quoted_amount  TEXT    NOT NULL,
  decision       TEXT    NOT NULL CHECK (decision IN ('paid','refused')),
  reason         TEXT    NOT NULL,
  tx_hash        TEXT    NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_decision ON decisions (decision);
CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions (ts);
`;

export interface Ledger {
  /** Absolute path of the backing SQLite file. */
  readonly path: string;
  recordDecision(entry: DecisionEntry): DecisionRow;
  /** Back-fill the on-chain transaction hash for an already-recorded payment. */
  recordSettlement(id: number, txHash: string): void;
  getCumulativeSpent(): bigint;
  getRows(): DecisionRow[];
  getSnapshot(): LedgerSnapshot;
  close(): void;
}

function assertBaseUnits(value: unknown, field: string): bigint {
  if (typeof value !== 'bigint') {
    throw new TypeError(
      `ledger: ${field} must be a bigint of base units, received ${typeof value}. ` +
        'Floats are rejected at the boundary on purpose.',
    );
  }
  if (value < 0n) {
    throw new RangeError(`ledger: ${field} must not be negative, received ${value}`);
  }
  return value;
}

function toRow(raw: Record<string, unknown>): DecisionRow {
  return {
    id: Number(raw.id),
    ts: String(raw.ts),
    url: String(raw.url),
    network: String(raw.network),
    asset: String(raw.asset),
    quotedAmountBaseUnits: BigInt(String(raw.quoted_amount)),
    decision: raw.decision as Decision,
    reason: String(raw.reason),
    txHash: raw.tx_hash === null || raw.tx_hash === undefined ? null : String(raw.tx_hash),
  };
}

/**
 * Open (and create if needed) a ledger at `dbPath`.
 *
 * Tests use this with a temp path. Production uses `getLedger()`.
 */
export function createLedger(dbPath: string): Ledger {
  const path = resolve(dbPath);
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.exec(SCHEMA);

  const insertStmt = db.prepare(
    `INSERT INTO decisions (ts, url, network, asset, quoted_amount, decision, reason, tx_hash)
     VALUES (@ts, @url, @network, @asset, @quoted_amount, @decision, @reason, @tx_hash)`,
  );
  const settleStmt = db.prepare(`UPDATE decisions SET tx_hash = @tx_hash WHERE id = @id`);
  const selectPaidStmt = db.prepare(
    `SELECT quoted_amount FROM decisions WHERE decision = 'paid' ORDER BY id`,
  );
  const selectAllStmt = db.prepare(`SELECT * FROM decisions ORDER BY id`);

  const write = db.transaction((entry: DecisionEntry): DecisionRow => {
    const amount = assertBaseUnits(entry.quotedAmountBaseUnits, 'quotedAmountBaseUnits');
    if (entry.decision !== 'paid' && entry.decision !== 'refused') {
      throw new TypeError(`ledger: decision must be 'paid' or 'refused', received ${String(entry.decision)}`);
    }

    const info = insertStmt.run({
      ts: new Date().toISOString(),
      url: entry.url,
      network: entry.network,
      asset: entry.asset,
      // Stringified BigInt into a TEXT column: exact, unbounded, greppable.
      quoted_amount: amount.toString(),
      decision: entry.decision,
      reason: entry.reason,
      tx_hash: entry.txHash ?? null,
    });

    return {
      id: Number(info.lastInsertRowid),
      ts: new Date().toISOString(),
      url: entry.url,
      network: entry.network,
      asset: entry.asset,
      quotedAmountBaseUnits: amount,
      decision: entry.decision,
      reason: entry.reason,
      txHash: entry.txHash ?? null,
    };
  });

  return {
    path,

    recordDecision(entry: DecisionEntry): DecisionRow {
      return write(entry);
    },

    recordSettlement(id: number, txHash: string): void {
      if (typeof txHash !== 'string' || txHash.length === 0) {
        throw new TypeError('ledger: txHash must be a non-empty string');
      }
      settleStmt.run({ id, tx_hash: txHash });
    },

    getCumulativeSpent(): bigint {
      // Deliberately a read of the table on every call, summed with BigInt
      // arithmetic. No cached total, no SQL integer accumulation.
      let total = 0n;
      for (const row of selectPaidStmt.all() as Array<{ quoted_amount: string }>) {
        total += BigInt(row.quoted_amount);
      }
      return total;
    },

    getRows(): DecisionRow[] {
      return (selectAllStmt.all() as Array<Record<string, unknown>>).map(toRow);
    },

    getSnapshot(): LedgerSnapshot {
      const rows = this.getRows();
      let cumulative = 0n;
      let paidCount = 0;
      for (const row of rows) {
        if (row.decision === 'paid') {
          cumulative += row.quotedAmountBaseUnits;
          paidCount += 1;
        }
      }
      return {
        cumulativeSpentBaseUnits: cumulative,
        paidCount,
        refusedCount: rows.length - paidCount,
        rows,
      };
    },

    close(): void {
      db.close();
    },
  };
}

let singleton: Ledger | undefined;

/**
 * Process-wide ledger, bound to `LEDGER_DB_PATH` (default `ledger/spend.db`).
 * Opened lazily so that merely importing this module does not create a file.
 */
export function getLedger(): Ledger {
  if (!singleton) {
    singleton = createLedger(process.env.LEDGER_DB_PATH ?? 'ledger/spend.db');
  }
  return singleton;
}
