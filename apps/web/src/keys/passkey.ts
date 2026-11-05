/**
 * Passkey (WebAuthn) as the user-presence gate before every signature, the web stand-in for
 * Face ID. It is a local gate: the engine verifies the Ed25519 device signature, not the
 * assertion. The challenge is the hash being signed, so the prompt is bound to this approval.
 */
import { idbGet, idbPut } from './idb.ts';

const CRED_ID = 'passkey-id';

export class PasskeyUnavailable extends Error {
  override name = 'PasskeyUnavailable';
}
export class PasskeyCancelled extends Error {
  override name = 'PasskeyCancelled';
}

export async function passkeySupported(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

function cancelled(e: unknown): never {
  if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError'))
    throw new PasskeyCancelled('passkey cancelled');
  throw e;
}

export async function hasPasskey(): Promise<boolean> {
  return (await idbGet<ArrayBuffer>(CRED_ID)) !== undefined;
}

export async function createPasskey(displayName: string): Promise<void> {
  if (!(await passkeySupported())) throw new PasskeyUnavailable('no passkey on this device');
  let cred: Credential | null;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'penny', id: location.hostname },
        user: { id: rand(16), name: displayName, displayName },
        challenge: rand(32),
        pubKeyCredParams: [
          { type: 'public-key', alg: -8 },
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        timeout: 60_000,
      },
    });
  } catch (e) {
    cancelled(e);
  }
  if (!(cred instanceof PublicKeyCredential)) throw new PasskeyCancelled('no credential');
  await idbPut(CRED_ID, cred.rawId);
}

/** Prompt for the passkey with userVerification required. Resolves only on a verified user. */
export async function confirmWithPasskey(challenge: Uint8Array): Promise<void> {
  const id = await idbGet<ArrayBuffer>(CRED_ID);
  if (!id) throw new PasskeyUnavailable('no passkey enrolled');
  try {
    const a = await navigator.credentials.get({
      publicKey: {
        challenge: challenge as BufferSource,
        allowCredentials: [{ type: 'public-key', id }],
        userVerification: 'required',
        rpId: location.hostname,
        timeout: 60_000,
      },
    });
    if (!a) throw new PasskeyCancelled('no assertion');
    const data = (a as PublicKeyCredential).response as AuthenticatorAssertionResponse;
    // flags byte at offset 32 of authenticatorData: bit 2 = user verified.
    const flags = new Uint8Array(data.authenticatorData)[32] ?? 0;
    if ((flags & 0x04) === 0) throw new PasskeyCancelled('user not verified');
  } catch (e) {
    cancelled(e);
  }
}
