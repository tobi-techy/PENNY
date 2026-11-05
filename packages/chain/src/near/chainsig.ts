import { keccak_256 } from '@noble/hashes/sha3.js';
import { z } from 'zod';
import { fromBase58 } from '../util/encoding.ts';
import type { NearRpc } from './rpc.ts';

/** NEAR Chain Signatures MPC contract on mainnet (docs.near.org/chain-abstraction/chain-signatures/implementation). */
export const MPC_CONTRACT_MAINNET = 'v1.signer';
/** Dedicated derivation path for the Glider owner key. One path per purpose/chain avoids cross-use (docs warning). */
export const GLIDER_OWNER_PATH = 'penny-glider-owner-1';

/** keccak256(uncompressed pubkey x||y)[12..] as checksummed 0x address. */
export function evmAddressFromSecp256k1(nearKey: string): string {
  if (!nearKey.startsWith('secp256k1:')) throw new Error('expected secp256k1 key');
  const raw = fromBase58(nearKey.slice('secp256k1:'.length));
  const xy = raw.length === 65 && raw[0] === 4 ? raw.slice(1) : raw;
  if (xy.length !== 64) throw new Error('expected 64-byte uncompressed secp256k1 key');
  const addr = Buffer.from(keccak_256(xy).slice(12)).toString('hex');
  return toChecksum(addr);
}

function toChecksum(hex40: string): string {
  const h = Buffer.from(keccak_256(new TextEncoder().encode(hex40))).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const c = hex40[i] ?? '';
    out += Number.parseInt(h[i] ?? '0', 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/**
 * Read-only: the EVM address a NEAR account controls via Chain Signatures at `path`.
 * Only that NEAR account (i.e. only the user's device key) can request signatures for it.
 */
export async function deriveEvmAddress(
  rpc: NearRpc,
  accountId: string,
  path: string = GLIDER_OWNER_PATH,
  mpcContract: string = MPC_CONTRACT_MAINNET,
): Promise<{ publicKey: string; address: string; ownerAccountId: string }> {
  const pk = z.string().parse(
    await rpc.callView(mpcContract, 'derived_public_key', {
      path,
      predecessor: accountId,
      domain_id: 0,
    }),
  );
  const address = evmAddressFromSecp256k1(pk);
  return { publicKey: pk, address, ownerAccountId: `eip155:0:${address}` };
}
