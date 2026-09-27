/**
 * sellers/honest-stall.ts — a well-behaved x402 seller.
 *
 * Charges a fair price, on the correct testnet network, in the correct asset.
 * This is the control case: if the purse refuses *this*, the policy is
 * misconfigured rather than the seller being abusive.
 *
 * Two routes, and the contrast between them is deliberate:
 *
 *   GET /forecast   paywalled at $0.01 of real Base Sepolia USDC
 *   GET /preview    the same payload, free
 *
 * Settlement goes through an x402 facilitator, which verifies the client's
 * EIP-3009 signature and executes the transfer on Base Sepolia. The facilitator
 * wallet therefore needs testnet ETH for gas and the buyer needs testnet USDC.
 */
import '../purse/env.js';
import { registerExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient, x402ResourceServer, type RouteConfig } from '@x402/core/server';
import { paymentMiddleware } from '@x402/express';
import express from 'express';
import { pathToFileURL } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';

const NETWORK = 'eip155:84532' as const;
const PORT = Number(process.env.HONEST_PORT ?? 4021);

/** The real, canonical Base Sepolia USDC contract. Not a stand-in. */
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

/** 10_000 base units = $0.01, comfortably inside a sane per-call cap. */
const PRICE_PER_FORECAST = '0.01';

const FORECAST = {
  horizonDays: 7,
  baseSepolia: {
    gasGwei: { p10: 0.01, median: 0.04, p90: 0.12 },
    usdcUsd: { open: 1.0, close: 1.0 },
  },
  note: 'synthetic demo data, not a real quote',
} as const;

/**
 * Read an optional env var, treating blank as absent.
 *
 * `??` is not enough: a `.env` line like `SELLER_PAY_TO_ADDRESS=` sets the
 * variable to an empty string, and `process.env.X ?? fallback` hands that empty
 * string straight through. For a payment destination that means authorising a
 * transfer to the zero address, so blanks are normalised to undefined here.
 */
function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

function requireEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(
      `sellers/honest-stall: ${name} is not set. See .env.example. ` +
        'A facilitator is required to verify and settle payments.',
    );
  }
  return value;
}

/**
 * The paywalled routes, built without touching a facilitator.
 *
 * Exported so a test can assert what the seller *declares* — network, asset,
 * price — without standing up a facilitator. Constructing the app is not
 * enough on its own, because the payment middleware cannot answer a request
 * without first asking a facilitator what it supports, so an in-process test of
 * the 402 handshake needs live infrastructure. Asserting the declared
 * requirement needs none of that, and it is the part that must be right.
 */
export function buildHonestRoutes(payTo: `0x${string}`): Record<string, RouteConfig> {
  return {
    'GET /forecast': {
      accepts: {
        scheme: 'exact',
        network: NETWORK,
        maxTimeoutSeconds: 30,
        price: PRICE_PER_FORECAST,
        payTo,
      },
      description: 'A seven-day Base Sepolia gas and USDC liquidity forecast.',
      mimeType: 'application/json',
    },
  };
}

export function createHonestApp(): express.Express {
  const facilitatorUrl = requireEnv('FACILITATOR_URL');
  const facilitatorKey = requireEnv('FACILITATOR_PRIVATE_KEY');
  const authToken = optionalEnv('FACILITATOR_AUTH_TOKEN');

  const account = privateKeyToAccount(facilitatorKey as `0x${string}`);
  const payTo = (optionalEnv('SELLER_PAY_TO_ADDRESS') as `0x${string}` | undefined) ?? account.address;

  const facilitatorClient = new HTTPFacilitatorClient({
    url: facilitatorUrl,
    // Keyed by path, not a flat object. A flat object here is silently dropped
    // by the client and every facilitator call ends up unauthenticated.
    ...(authToken
      ? {
          createAuthHeaders: async () => {
            const headers = { Authorization: `Bearer ${authToken}` };
            return { verify: headers, settle: headers, supported: headers };
          },
        }
      : {}),
  });

  const routes = buildHonestRoutes(payTo);

  const resourceServer = new x402ResourceServer(facilitatorClient);
  registerExactEvmScheme(resourceServer, { networks: [NETWORK] });

  const app = express();
  app.use(express.json());
  // Only /forecast is registered with the payment middleware, so /preview falls
  // through untouched. That contrast is the point of having it: same host, same
  // payload shape, one route behind a paywall and one not.
  app.use(paymentMiddleware(routes, resourceServer));

  app.get('/forecast', (_req, res) => {
    res.json({
      resource: 'forecast',
      paywalled: true,
      pricePaid: `${PRICE_PER_FORECAST} USDC on ${NETWORK}`,
      asset: BASE_SEPOLIA_USDC,
      forecast: FORECAST,
    });
  });

  /**
   * The same forecast, free. Exists so a run can show the contrast in one place:
   * a 200 with `paywalled: false` next to a 402, both from the same seller, and
   * only one of which touches the ledger.
   */
  app.get('/preview', (_req, res) => {
    res.json({
      resource: 'forecast',
      paywalled: false,
      note: 'free route, so the purse records no decision and spends nothing',
      forecast: FORECAST,
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, network: NETWORK, payTo, facilitator: facilitatorUrl });
  });

  return app;
}

/** Listen on `port`. Exported so a sample run can pick an ephemeral port. */
export async function startHonestServer(
  port: number = PORT,
): Promise<{ port: number; close: () => Promise<void> }> {
  const app = createHonestApp();
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const actual = (server.address() as { port: number }).port;
      console.log(`[honest]  listening on http://localhost:${actual}`);
      console.log(`[honest]  network  ${NETWORK}`);
      console.log(`[honest]  asset    ${BASE_SEPOLIA_USDC} (Base Sepolia USDC)`);
      console.log(`[honest]  price    ${PRICE_PER_FORECAST} USDC per /forecast`);
      console.log(`[honest]  routes   GET /forecast (paid)  GET /preview (free)  GET /health`);
      resolve({ port: actual, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

// Only listen when executed directly, so importing this module does not bind a
// port as a side effect. Compared as URLs rather than strings: a path
// containing a space is percent-encoded in import.meta.url but not in argv.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startHonestServer();
}
