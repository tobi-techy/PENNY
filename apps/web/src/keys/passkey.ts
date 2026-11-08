/**
 * Passkeys (WebAuthn) for the no-install path. The browser only runs the ceremony; the
 * engine checks everything on the server: the challenge it issued (single use), origin
 * and rpId (PUBLIC_BASE_URL), user verification, the signature against the stored COSE
 * key, and the sign count. Nothing here decides whether an approval is valid.
 */
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';

export class PasskeyUnavailable extends Error {
  override name = 'PasskeyUnavailable';
}
export class PasskeyCancelled extends Error {
  override name = 'PasskeyCancelled';
}

export async function passkeySupported(): Promise<boolean> {
  if (typeof window === 'undefined' || !browserSupportsWebAuthn()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function cancelled(e: unknown): never {
  const name = (e as { name?: string }).name;
  if (name === 'NotAllowedError' || name === 'AbortError') throw new PasskeyCancelled('cancelled');
  throw e;
}

/** Registration options for the challenge the engine issued at setup. */
export function registrationOptions(c: { challenge: string; rpId: string; userId: string }) {
  return {
    challenge: c.challenge,
    rp: { id: c.rpId, name: 'Penny' },
    user: { id: c.userId, name: 'Penny', displayName: 'Penny' },
    pubKeyCredParams: [
      { type: 'public-key' as const, alg: -8 },
      { type: 'public-key' as const, alg: -7 },
      { type: 'public-key' as const, alg: -257 },
    ],
    authenticatorSelection: {
      userVerification: 'required' as const,
      residentKey: 'preferred' as const,
      authenticatorAttachment: 'platform' as const,
    },
    attestation: 'none' as const,
    timeout: 60_000,
  };
}

/** Authentication options: challenge = the approval's challenge, only this user's passkeys. */
export function authenticationOptions(c: { challenge: string; rpId: string; passkeys: string[] }) {
  return {
    challenge: c.challenge,
    rpId: c.rpId,
    allowCredentials: c.passkeys.map((id) => ({ id, type: 'public-key' as const })),
    userVerification: 'required' as const,
    timeout: 60_000,
  };
}

export async function createPasskey(c: { challenge: string; rpId: string; userId: string }) {
  if (!(await passkeySupported())) throw new PasskeyUnavailable('no passkey on this device');
  try {
    return await startRegistration({ optionsJSON: registrationOptions(c) });
  } catch (e) {
    cancelled(e);
  }
}

/** Face ID on the tap. Safari only starts it from a user gesture, so call this from onClick. */
export async function assertPasskey(c: { challenge: string; rpId: string; passkeys: string[] }) {
  if (!(await passkeySupported())) throw new PasskeyUnavailable('no passkey on this device');
  try {
    return await startAuthentication({ optionsJSON: authenticationOptions(c) });
  } catch (e) {
    cancelled(e);
  }
}
