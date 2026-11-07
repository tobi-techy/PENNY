/**
 * The browser's device key. Ed25519 via WebCrypto with a non-extractable private key; the
 * CryptoKeyPair lives in IndexedDB (structured clone keeps it non-extractable).
 *
 * There is deliberately no software fallback. The earlier version kept a raw 32-byte
 * seed in IndexedDB when WebCrypto lacked Ed25519, which any script on this origin
 * could read, and the engine cannot tell the two apart from the signature alone.
 * A browser without WebCrypto Ed25519 gets no key and is told to use the iPhone app.
 */
import { idbGet, idbPut } from './idb.ts';

export interface DeviceKey {
  publicKey: Uint8Array;
  kind: 'webcrypto';
  sign(message: Uint8Array): Promise<Uint8Array>;
}

type Stored = { kind: 'webcrypto'; pair: CryptoKeyPair; publicKey: Uint8Array };

const KEY_ID = 'device-key';

/** Thrown when this browser cannot hold a non-extractable Ed25519 key. */
export class NoSecureKeyStore extends Error {
  override name = 'NoSecureKeyStore';
}

async function webcryptoEd25519(): Promise<boolean> {
  try {
    const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    return 'privateKey' in k;
  } catch {
    return false;
  }
}

function wrap(s: Stored): DeviceKey {
  return {
    kind: 'webcrypto',
    publicKey: s.publicKey,
    async sign(m) {
      const sig = await crypto.subtle.sign('Ed25519', s.pair.privateKey, m as BufferSource);
      return new Uint8Array(sig);
    },
  };
}

export async function loadDeviceKey(): Promise<DeviceKey | null> {
  const s = await idbGet<Stored>(KEY_ID);
  // A key stored by the old software fallback has no CryptoKeyPair; refuse it.
  if (s?.kind !== 'webcrypto' || !s.pair) return null;
  return wrap(s);
}

export async function createDeviceKey(): Promise<DeviceKey> {
  if (!(await webcryptoEd25519())) throw new NoSecureKeyStore('no webcrypto ed25519');
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const stored: Stored = { kind: 'webcrypto', pair, publicKey };
  await idbPut(KEY_ID, stored);
  return wrap(stored);
}
