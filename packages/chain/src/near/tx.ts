import { KeyType } from '@near-js/crypto';
import {
  type Action,
  createTransaction,
  Signature,
  SignedTransaction,
  type Transaction,
} from '@near-js/transactions';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromBase58, toBase58, toBase64 } from '../util/encoding.ts';
import type { TxSigner } from './keys.ts';

export interface BuiltTx {
  transaction: Transaction;
  /** base58(sha256(borsh(Transaction))) — the hash the network will report. */
  hash: string;
}

export interface SignedTx extends BuiltTx {
  signedBase64: string;
}

export function buildTx(params: {
  signerId: string;
  signerPublicKey: Transaction['publicKey'];
  receiverId: string;
  nonce: bigint;
  actions: Action[];
  blockHash: string;
}): BuiltTx {
  const transaction = createTransaction(
    params.signerId,
    params.signerPublicKey,
    params.receiverId,
    params.nonce,
    params.actions,
    fromBase58(params.blockHash),
  );
  return { transaction, hash: toBase58(sha256(transaction.encode())) };
}

export async function signTx(built: BuiltTx, signer: TxSigner): Promise<SignedTx> {
  const digest = sha256(built.transaction.encode());
  const sig = await signer.sign(digest);
  const signed = new SignedTransaction({
    transaction: built.transaction,
    signature: new Signature({ keyType: KeyType.ED25519, data: sig }),
  });
  return { ...built, signedBase64: toBase64(signed.encode()) };
}
