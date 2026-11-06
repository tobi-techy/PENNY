/**
 * Invest live smoke. Broadcasts NOTHING and moves no money.
 *   bun run scripts/invest-smoke.ts [amountUsd=1] [asset=SOL]
 *
 * 1. Real non-dry 1Click quote: USDC on NEAR -> asset, recipientType INTENTS, recipient and
 *    refundTo = NEAR_APP_ACCOUNT_ID (default penny.near). A non-dry quote only reserves a
 *    deposit address; nothing happens until someone sends USDC to it.
 * 2. Builds the exact deposit actions Penny would put on the Face ID card
 *    (storage_deposit if the deposit address is unregistered on USDC, then plain ft_transfer).
 * 3. Signs them as a NEP-366 SignedDelegateAction with a THROWAWAY key generated in memory
 *    (not on any account, so the signature is useless on chain), decodes it back and checks
 *    the signature and fields locally.
 * 4. Reads 1Click status for the deposit address (expect PENDING_DEPOSIT).
 * It never calls the relayer, send_tx, or /v0/deposit/submit.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { ChainAdapter } from '../src/adapter.ts';
import { OneClickClient, quoteFeeBps } from '../src/intents/oneclick.ts';
import { INVEST_ASSETS, isInvestAsset } from '../src/intents/prices.ts';
import { buildSignedDelegateAction, decodeSignedDelegateAction } from '../src/near/delegate.ts';
import { MAINNET_RPC_URL, NearRpc } from '../src/near/rpc.ts';

const amountUsd = process.argv[2] ?? '1';
const asset = process.argv[3] ?? 'SOL';
if (!isInvestAsset(asset)) throw new Error('asset must be ETH, SOL or NEAR');
const user = process.env.NEAR_APP_ACCOUNT_ID ?? 'penny.near';

const rpc = new NearRpc({ url: process.env.NEAR_RPC_URL ?? MAINNET_RPC_URL });
const adapter = new ChainAdapter({
  rpc,
  appAccountId: user,
  relayerAccountId: user, // no relayer key: this adapter cannot relay even if asked
  oneClick: new OneClickClient({
    ...(process.env.ONECLICK_API_KEY ? { apiKey: process.env.ONECLICK_API_KEY } : {}),
    ...(process.env.ONECLICK_JWT ? { jwt: process.env.ONECLICK_JWT } : {}),
  }),
});

const q = await adapter.quoteInvestForPlan({
  quoteId: 'smoke',
  amountUsd,
  destinationAsset: INVEST_ASSETS[asset].assetId,
  recipient: user,
  recipientType: 'INTENTS',
  userAccountId: user,
  slippageBps: 100,
  dry: false,
});
const built = await adapter.buildActions(
  { kind: 'invest', amountUsd, portfolioId: asset, quoteId: 'smoke' },
  user,
);

const secret = ed25519.utils.randomSecretKey(); // throwaway, never stored
const block = await rpc.finalBlock();
const sda = buildSignedDelegateAction({
  secretKey: secret,
  senderId: user,
  receiverId: built.receiverId,
  actions: built.actions,
  nonce: 1n,
  maxBlockHeight: block.height + 200n,
});
const decoded = decodeSignedDelegateAction(sda);
const sigOk = ed25519.verify(decoded.signature, decoded.signedHash, ed25519.getPublicKey(secret));
const status = await adapter.oneClick.status(q.depositAddress ?? '');

const out = {
  at: new Date().toISOString(),
  request: { amountUsd, asset, user, slippageBps: 100, recipientType: 'INTENTS' },
  quote: {
    correlationId: q.response.correlationId,
    amountIn: q.amountIn.toString(),
    amountInUsd: q.response.quote.amountInUsd,
    amountOut: q.amountOut.toString(),
    amountOutFormatted: q.response.quote.amountOutFormatted,
    amountOutUsd: q.response.quote.amountOutUsd,
    minAmountOut: q.minAmountOut.toString(),
    feeBps: quoteFeeBps(q.response),
    depositAddress: q.depositAddress,
    depositAddressType: /^[0-9a-f]{64}$/.test(q.depositAddress ?? '')
      ? 'NEAR implicit account (64 hex)'
      : 'other',
    oneClickDeadline: q.response.quote.deadline,
    cardExpiresAt: q.expiresAt.toISOString(),
  },
  delegate: {
    receiverId: built.receiverId,
    actions: built.actions.map((a) => (a.type === 'FunctionCall' ? a.methodName : a.type)),
    sdaBytes: Buffer.from(sda, 'base64').length,
    decodedSender: decoded.senderId,
    decodedReceiver: decoded.receiverId,
    signatureValid: sigOk,
    relayed: false,
  },
  status: status.status,
};
console.log(JSON.stringify(out, null, 2));
