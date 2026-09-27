/**
 * scripts/agentSample.ts — run the real agent loop twice and export the result.
 *
 * The spec calls for the agent to be run once against the honest stall and once
 * with the rogue stall included, with the resulting decisions exported to
 * `ledger/sample-run.json`. Driving that with a live model needs
 * `ANTHROPIC_API_KEY`, which is not always available, so this script has two
 * modes:
 *
 *   --live   use the Anthropic SDK, exactly as `npm run agent` does
 *   (default) drive the same `runAgent` loop with a scripted model
 *
 * The scripted mode is not a mock of the *purse*. It calls the identical
 * `runAgent`, which calls the identical `paidFetch`, which calls the identical
 * `guardedFetch` against the identical real sellers over real HTTP, booking
 * into a real SQLite ledger. The only thing replaced is the language model, so
 * the exported decisions are real evidence about the money path and only
 * synthetic evidence about model behaviour. Every field in the export says which
 * mode produced it.
 *
 *   npx tsx scripts/agentSample.ts            # scripted, no key needed
 *   npx tsx scripts/agentSample.ts --live     # real Anthropic SDK
 */
import '../purse/env.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { generatePrivateKey } from 'viem/accounts';
import { config } from '../purse/config.js';
import { createLedger, type DecisionRow, type Ledger } from '../purse/ledger.js';
import { formatBaseUnits } from '../purse/guardedFetch.js';
import {
  runAgent,
  type AgentModel,
  type ContentBlock,
  type TranscriptEntry,
} from '../agent/agent.js';
import { paidFetchTool } from '../purse/tool.js';
import { startHonestServer } from '../sellers/honest-stall.js';
import { startRogueServer } from '../sellers/rogue-stall.js';

const OUT = resolve('ledger/sample-run.json');
const LIVE = process.argv.includes('--live');

const DEFAULT_QUESTION =
  "Does this week's rainfall forecast predict a mandi tomato price move?";

/**
 * Positional question, if one was given.
 *
 * Only arguments after a bare `--` count. Filtering on "does not start with
 * --" is not enough: `tsx` and `node` both pass the interpreter and the script
 * path through argv, and without the `--` guard the question silently becomes
 * "/usr/bin/node" and lands in the exported JSON and the model prompt.
 */
const QUESTION = (() => {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  const positional = sep === -1 ? argv : argv.slice(sep + 1);
  const fromEnv = process.env.AGENT_QUESTION?.trim();
  return positional[0]?.trim() || fromEnv || DEFAULT_QUESTION;
})();

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5';

interface RunSpec {
  readonly name: string;
  readonly includeRogue: boolean;
  readonly sources: readonly string[];
}

interface RunResult {
  readonly name: string;
  readonly includeRogue: boolean;
  readonly question: string;
  readonly sources: readonly string[];
  readonly summary: string;
  readonly stoppedBecause: string;
  readonly turns: number;
  readonly fetches: ReadonlyArray<{
    readonly url: string;
    readonly paid: boolean;
    readonly refusalCode: string | null;
    readonly spentBaseUnits: string;
    readonly spentFormatted: string;
  }>;
  /** Already stringified for JSON: see {@link toExportRow}. */
  readonly ledgerRows: ReadonlyArray<ReturnType<typeof toExportRow>>;
  readonly totals: {
    readonly cumulativeSpentBaseUnits: string;
    readonly cumulativeSpentFormatted: string;
    readonly paidCount: number;
    readonly refusedCount: number;
    readonly withinBudget: boolean;
  };
}

/** The scripted model, used when there is no API key or --live was not passed. */
function scriptedModel(plan: readonly string[]): AgentModel {
  let i = 0;
  return async () => {
    // Walk the candidate list one URL per turn, then answer. This is the shape a
    // real model produces, and it deliberately includes the abusive URLs so the
    // refusals land in the ledger.
    if (i < plan.length) {
      const url = plan[i++]!;
      return { text: null, toolCalls: [{ url, toolUseId: `call_${i}` }] };
    }
    return {
      text:
        'Rainfall and mandi tomato prices: the forecast endpoint I could reach ' +
        'provides gas and USDC liquidity data, not rainfall, so it does not ' +
        'support a claim about tomato prices. Several other candidate sources ' +
        'were refused by the operator policy and cost nothing. I have no ' +
        'verified rainfall-to-price evidence from these endpoints.',
      toolCalls: null,
    };
  };
}

/** The real Anthropic model, behind the same narrow interface. */
function liveModel(): AgentModel {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Re-run without --live to use the scripted model, ' +
        'or set the key to exercise the real SDK.',
    );
  }
  const anthropic = new Anthropic({ apiKey });

  return async (transcript: readonly TranscriptEntry[]) => {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools: [
        {
          name: paidFetchTool.name,
          description: paidFetchTool.description,
          input_schema: paidFetchTool.input_schema,
        },
      ],
      messages: toSdkMessages(transcript),
    });

    const content = response.content as ContentBlock[];
    const text = content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    const toolUses = content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> =>
        b.type === 'tool_use' && b.name === 'paid_fetch',
    );

    if (toolUses.length === 0) return { text: text || null, toolCalls: null, blocks: content };
    return {
      text: text || null,
      toolCalls: toolUses.map((u) => ({ url: String(u.input.url ?? ''), toolUseId: u.id })),
      blocks: content,
    };
  };
}

type SdkMessage = { role: 'user' | 'assistant'; content: string | ContentBlock[] };

/** Replay a loop transcript as SDK messages. Mirrors the adapter in agent.ts. */
function toSdkMessages(transcript: readonly TranscriptEntry[]): SdkMessage[] {
  const messages: SdkMessage[] = [];
  let i = 0;
  while (i < transcript.length) {
    const entry = transcript[i]!;
    if (entry.role === 'user') {
      messages.push({ role: 'user', content: entry.text });
      i++;
      continue;
    }
    if (entry.role === 'assistant') {
      const results: ContentBlock[] = [];
      let j = i + 1;
      while (j < transcript.length) {
        const r = transcript[j]!;
        if (r.role !== 'tool') break;
        results.push({
          type: 'tool_result',
          // Straight from the model. The old `?? r.url` fallback would put a
          // URL in a tool_use_id field, which the API rejects outright.
          tool_use_id: r.toolUseId,
          content: r.text,
        });
        j++;
      }
      if (entry.blocks) {
        messages.push({ role: 'assistant', content: [...entry.blocks] });
        if (results.length > 0) messages.push({ role: 'user', content: results });
      } else {
        messages.push({ role: 'assistant', content: entry.text });
      }
      i = j;
      continue;
    }
    i++;
  }
  return messages;
}

/**
 * `DecisionRow` carries `quotedAmountBaseUnits` as a bigint, and `JSON.stringify`
 * throws on a bigint rather than silently truncating it. Convert on the way out
 * so every money field in the export is the same stringified integer, and no
 * float ever touches a total.
 */
function toExportRow(row: DecisionRow) {
  return {
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
  };
}

async function execute(spec: RunSpec, ledger: Ledger, model: AgentModel): Promise<RunResult> {
  const firstRow = ledger.getSnapshot().rows.length;

  const result = await runAgent({
    question: QUESTION,
    sources: spec.sources,
    model,
    ledger,
    onFetch: (url, outcome) => {
      // "free" is a claim that content came back without money moving. A 500 is
      // not free content, it is a broken request, and labelling it "free" in the
      // committed evidence would misreport a dead facilitator as a working
      // route. So the status is shown, and a non-2xx is called out as such.
      // A refusal is not one event, it is two, and the word matters. Most
      // refusals are judged from the quote before a payload exists: nothing was
      // signed, nothing left the wallet, and "refused" is the whole truth. But a
      // signature that was already dispatched and never confirmed also arrives
      // here with `paid === false`, and calling that "refused" tells a reader the
      // safe thing that is false — it implies a retry costs nothing, on a request
      // that may already have been paid for. The summary line below counts the
      // spent amount, so the per-route line has to agree with it or the two lines
      // describe different runs.
      //
      // `PaidFetchOutcome` has no `signed` field. `spentBaseUnits` is its mirror:
      // `purse/tool.ts` sets it from the dispatch flag, exactly so the reported
      // total cannot drift from the ledger. Keying the tag off the same number
      // keeps this line and the summary keyed off the same fact.
      const tag = outcome.paid
        ? `paid ${formatBaseUnits(outcome.spentBaseUnits)}`
        : outcome.refusalCode
          ? outcome.spentBaseUnits > 0n
            ? `paid ${formatBaseUnits(outcome.spentBaseUnits)}, settlement unconfirmed (${outcome.refusalCode})`
            : `refused (${outcome.refusalCode})`
          : outcome.status >= 200 && outcome.status < 300
            ? `free ${outcome.status}`
            : `not free — HTTP ${outcome.status}, no content`;
      console.log(`[${spec.name}] ${url.replace(/^https?:\/\/[^/]+/, '').padEnd(24)} ${tag}`);
    },
  });

  const snapshot = ledger.getSnapshot();
  const rows = snapshot.rows.slice(firstRow);

  console.log(
    `[${spec.name}] spent ${formatBaseUnits(snapshot.cumulativeSpentBaseUnits)} ` +
      `(${snapshot.paidCount} paid, ${snapshot.refusedCount} refused) — ${result.stoppedBecause}`,
  );
  console.log('');

  return {
    name: spec.name,
    includeRogue: spec.includeRogue,
    question: QUESTION,
    sources: spec.sources,
    summary: result.summary,
    stoppedBecause: result.stoppedBecause,
    turns: result.turns,
    fetches: result.fetches.map((f) => ({
      url: f.url,
      paid: f.paid,
      refusalCode: f.refusalCode,
      spentBaseUnits: f.spentBaseUnits.toString(),
      spentFormatted: formatBaseUnits(f.spentBaseUnits),
    })),
    ledgerRows: rows.map(toExportRow),
    totals: {
      cumulativeSpentBaseUnits: snapshot.cumulativeSpentBaseUnits.toString(),
      cumulativeSpentFormatted: formatBaseUnits(snapshot.cumulativeSpentBaseUnits),
      paidCount: snapshot.paidCount,
      refusedCount: snapshot.refusedCount,
      withinBudget: snapshot.cumulativeSpentBaseUnits <= config.totalBudgetBaseUnits,
    },
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'coin-purse-agent-'));
  const ledger = createLedger(join(dir, 'sample.db'));

  // The honest seller refuses to boot without a facilitator key, because it
  // genuinely settles. For a sample run that has to work offline, fall back to
  // a throwaway key: the wallet is never funded, so nothing can settle either
  // way, and the run's refusals are unaffected. This is recorded in the export
  // so the output is never mistaken for a settled payment.
  if (!process.env.FACILITATOR_PRIVATE_KEY) {
    // Generated fresh at runtime, in memory, and never written down. Committing
    // even an "obviously fake" 32-byte hex literal trains the eye to skip past
    // one, and the day someone pastes a real key in its place there is nothing
    // to catch it. The key is unfunded, so nothing can settle either way, and
    // the run's refusals are unaffected.
    console.log('[sample] FACILITATOR_PRIVATE_KEY not set; using an unfunded throwaway key so the honest seller can boot.');
    process.env.FACILITATOR_PRIVATE_KEY = generatePrivateKey();
  }

  const honest = await startHonestServer(0);
  const rogue = await startRogueServer(0);
  const honestBase = `http://127.0.0.1:${honest.port}`;
  const rogueBase = `http://127.0.0.1:${rogue.port}`;

  const honestSources = [`${honestBase}/preview`, `${honestBase}/forecast`];
  const rogueSources = [
    `${rogueBase}/free`,
    `${rogueBase}/overpriced`,
    `${rogueBase}/raise-budget`,
    `${rogueBase}/wrong-network`,
    `${rogueBase}/wrong-asset`,
    `${rogueBase}/decimal-amount`,
    `${rogueBase}/cheap-then-ruinous`,
    `${rogueBase}/ruinous-then-cheap`,
    `${rogueBase}/upto-scheme`,
  ];

  const specs: RunSpec[] = [
    { name: 'honest-only', includeRogue: false, sources: honestSources },
    { name: 'honest-and-rogue', includeRogue: true, sources: [...honestSources, ...rogueSources] },
  ];

  console.log(`[sample] mode            ${LIVE ? 'live (Anthropic SDK)' : 'scripted model'}`);
  console.log(`[sample] question        ${QUESTION}`);
  console.log(`[sample] policy          ${formatBaseUnits(config.perCallMaxBaseUnits)} per call, ${formatBaseUnits(config.totalBudgetBaseUnits)} total`);
  console.log(`[sample] honest seller   ${honestBase}`);
  console.log(`[sample] rogue seller    ${rogueBase}`);
  console.log('');

  // The scripted model is created per run so each gets a fresh plan, and so a
  // live run cannot be silently replaced by a scripted one.
  const makeModel = (plan: readonly string[]): AgentModel =>
    LIVE ? liveModel() : scriptedModel(plan);

  const runs: RunResult[] = [];
  runs.push(await execute(specs[0]!, ledger, makeModel(honestSources)));
  runs.push(
    await execute(specs[1]!, ledger, makeModel([...honestSources, ...rogueSources])),
  );

  await honest.close();
  await rogue.close();

  const final = ledger.getSnapshot();

  // The note about the honest stall's /forecast has to be read off the ledger,
  // not asserted. Whether that route was reached depends on whether a
  // facilitator answered, and that varies by machine and by run, so a hardcoded
  // claim about it is a note that can contradict the rows printed beside it.
  const forecastPaid = final.rows.some(
    (row) => row.url.replace(/^https?:\/\/[^/]+/, '').endsWith('/forecast') && row.decision === 'paid',
  );
  const forecastNote = forecastPaid
    ? 'The honest stall\'s paid /forecast WAS reached this time. Its 402 was priced within policy, a signature was dispatched, and the row stayed "paid" with a null txHash because settlement never confirmed — the conservative reading. It is evidence about the paid path as far as dispatch, and evidence of nothing about settlement.'
    : 'The honest stall\'s paid /forecast is never reached in this run, so it is not evidence about the paid path. With no facilitator reachable it answers HTTP 500, which is recorded as a failed request and not as free content. Only /preview (HTTP 200, genuinely free) exercises the free path.';
  ledger.close();
  rmSync(dir, { recursive: true, force: true });

  const report = {
    generatedAt: new Date().toISOString(),
    mode: LIVE ? 'live' : 'scripted',
    model: LIVE ? MODEL : 'scripted (no Anthropic SDK call)',
    facilitatorKey: process.env.FACILITATOR_PRIVATE_KEY
      ? 'configured (unfunded in this run)'
      : 'not set',
    question: QUESTION,
    policy: {
      perCallMaxBaseUnits: config.perCallMaxBaseUnits.toString(),
      perCallMaxFormatted: formatBaseUnits(config.perCallMaxBaseUnits),
      totalBudgetBaseUnits: config.totalBudgetBaseUnits.toString(),
      totalBudgetFormatted: formatBaseUnits(config.totalBudgetBaseUnits),
      allowedNetworks: config.allowedNetworks,
      allowedAssets: config.allowedAssets,
    },
    runs,
    cumulativeAcrossRuns: {
      cumulativeSpentBaseUnits: final.cumulativeSpentBaseUnits.toString(),
      cumulativeSpentFormatted: formatBaseUnits(final.cumulativeSpentBaseUnits),
      paidCount: final.paidCount,
      refusedCount: final.refusedCount,
      withinBudget: final.cumulativeSpentBaseUnits <= config.totalBudgetBaseUnits,
    },
    decisions: final.rows.map(toExportRow),
    notes: [
      LIVE
        ? 'Produced by a live Anthropic model. Tool calls, refusals, and payments are real.'
        : 'Produced by the scripted model. The language model is the only synthetic part: runAgent, paidFetch, guardedFetch, the sellers, HTTP, and SQLite are all real.',
      'Two runs share one ledger, so the second run starts with the first run\'s spend already counted. That is the point: the budget is cumulative across processes, not per-conversation.',
      'honest-only hit the honest stall alone. honest-and-rogue added the abusive endpoints; the refusals are the interesting rows.',
      'A refusal is recorded only when the guard could read a price to judge. A 402 with no PAYMENT-REQUIRED header, or an empty accepts list, has no network, asset, or amount to attribute a row to, so it is reported in run.fetches but has no ledger row.',
      'On-chain settlement is not exercised: it needs a funded Base Sepolia wallet and a live facilitator. Rows with a dispatched signature and no confirmation stay "paid" with a null txHash, on purpose.',
      forecastNote,
    ],
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`[sample] total across runs ${formatBaseUnits(final.cumulativeSpentBaseUnits)} of ${formatBaseUnits(config.totalBudgetBaseUnits)}`);
  console.log(`[sample] paid=${final.paidCount} refused=${final.refusedCount}`);
  console.log(`[sample] wrote ${OUT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
