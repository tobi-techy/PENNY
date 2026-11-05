/**
 * The browser's device key. Ed25519 via WebCrypto with a non-extractable private key; the
 * CryptoKeyPair lives in IndexedDB (structured clone keeps it non-extractable). If the browser
 * has no WebCrypto Ed25519, we fall back to @noble/curves and keep the 32-byte seed in IndexedDB,
 * which is weaker (readable by any script on this origin) and is reported as such.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { idbGet, idbPut } from './idb.ts';

export interface DeviceKey {
  publicKey: Uint8Array;
  kind: 'webcrypto' | 'noble';
  sign(message: Uint8Array): Promise<Uint8Array>;
}

type Stored =
  | { kind: 'webcrypto'; pair: CryptoKeyPair; publicKey: Uint8Array }
  | { kind: 'noble'; seed: Uint8Array; publicKey: Uint8Array };

const KEY_ID = 'device-key';

async function webcryptoEd25519(): Promise<boolean> {
  try {
    const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    return 'privateKey' in k;
  } catch {
    return false;
  }
}

function wrap(s: Stored): DeviceKey {
  if (s.kind === 'webcrypto') {
    return {
      kind: 'webcrypto',
      publicKey: s.publicKey,
      async sign(m) {
        const sig = await crypto.subtle.sign('Ed25519', s.pair.privateKey, m as BufferSource);
        return new Uint8Array(sig);
      },
    };
  }
  return {
    kind: 'noble',
    publicKey: s.publicKey,
    async sign(m) {
      return ed25519.sign(m, s.seed);
    },
  };
}

export async function loadDeviceKey(): Promise<DeviceKey | null> {
  const s = await idbGet<Stored>(KEY_ID);
  return s ? wrap(s) : null;
}

export async function createDeviceKey(): Promise<DeviceKey> {
  let stored: Stored;
  if (await webcryptoEd25519()) {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    stored = { kind: 'webcrypto', pair, publicKey };
  } else {
    const seed = ed25519.utils.randomSecretKey();
    stored = { kind: 'noble', seed, publicKey: ed25519.getPublicKey(seed) };
  }
  await idbPut(KEY_ID, stored);
  return wrap(stored);
}
