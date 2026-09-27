import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // `purse/config.ts` reads the policy at import time and throws if it is
    // missing, which is the behaviour we want in production and a nuisance in
    // tests. Setting it here means the guard is exercised against a real
    // frozen policy rather than a mock, so the tests and the runtime agree.
    env: {
      PER_CALL_MAX_BASE_UNITS: '50000', // 0.05 USDC
      TOTAL_BUDGET_BASE_UNITS: '5000000', // 5.00 USDC
      ALLOWED_NETWORKS: 'eip155:84532', // Base Sepolia
      ALLOWED_ASSETS: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia USDC
      // Throwaway key. Signs nothing in these tests: the x402 scheme is stubbed.
      WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
    },
  },
});
