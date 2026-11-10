import { describe, expect, test } from 'bun:test';
import { chainAdapterFromEnv } from '../src/adapter.ts';

describe('adapter env wiring', () => {
  test('NEAR_USDC_CONTRACT and PENNY_GUARD_CONTRACT reach the adapter on testnet', () => {
    const adapter = chainAdapterFromEnv({
      NEAR_RPC_URL: 'https://rpc.testnet.near.org',
      NEAR_USDC_CONTRACT: 'tusd.testnet',
      PENNY_GUARD_CONTRACT: 'guard.penny.testnet',
    });
    expect(adapter.mode.network).toBe('testnet');
    expect(adapter.usdc).toBe('tusd.testnet');
    expect(adapter.guardContract).toBe('guard.penny.testnet');
  });

  test('the shared Guard is opt-in: unset means autopilot off', () => {
    const adapter = chainAdapterFromEnv({ NEAR_RPC_URL: 'https://rpc.testnet.near.org' });
    expect(adapter.guardContract).toBeUndefined();
  });

  test('a dollar token override on mainnet fails closed', () => {
    expect(() =>
      chainAdapterFromEnv({
        NEAR_RPC_URL: 'https://rpc.mainnet.fastnear.com',
        NEAR_USDC_CONTRACT: 'tusd.testnet',
      }),
    ).toThrow('NEAR_USDC_CONTRACT may only be overridden on testnet');
  });
});
