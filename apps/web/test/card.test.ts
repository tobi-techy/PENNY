import { describe, expect, test } from 'bun:test';
import { countdown, pillFor, readCard, styleFor, tokenFromPath } from '../src/cardView.ts';
import { authenticationOptions, registrationOptions } from '../src/keys/passkey.ts';

// a made-up 43-char base64url card token (built, not a literal, so it never looks like a secret)
const token = 'A'.repeat(42) + 'Q';

describe('link card page', () => {
  test('reads the card token from /a/<token>; old /a/apr_ links are not tokens', () => {
    expect(tokenFromPath(`/a/${token}`)).toBe(token);
    expect(tokenFromPath('/a/apr_01JC0000000000000000000000')).toBeNull();
    expect(tokenFromPath('/setup')).toBeNull();
  });

  test('an unknown card type renders as a plain card', () => {
    const c = readCard({
      title: 'Rain at 4pm',
      type: 'weather',
      lines: [{ value: 'Take a coat' }, 7],
    });
    expect(c?.lines).toEqual([{ value: 'Take a coat' }]);
    expect(c?.state).toBe('done');
    expect(styleFor('weather')).toEqual({ color: '#B1C3D8', tag: 'PENNY', known: false });
    expect(readCard({ lines: [] })).toBeNull();
  });

  test('receipt links must be https', () => {
    expect(readCard({ title: 'x', receiptUrl: 'javascript:alert(1)' })?.receiptUrl).toBeUndefined();
    expect(
      readCard({ title: 'x', receiptUrl: 'https://testnet.nearblocks.io/txns/a' })?.receiptUrl,
    ).toBe('https://testnet.nearblocks.io/txns/a');
  });

  test('pills and countdown in plain words', () => {
    expect(pillFor('ready')).toBe('Approve with Face ID');
    expect(pillFor('expired')).toBe('Get a new card');
    expect(pillFor('sent')).toBe('Sent');
    expect(countdown(new Date(90_000).toISOString(), 0)).toBe('1:30 left');
  });
});

describe('passkey options (the server checks the result)', () => {
  test('approve: the approval challenge, this user’s passkeys, user verification required', () => {
    const o = authenticationOptions({ challenge: 'ch', rpId: 'penny.test', passkeys: ['a', 'b'] });
    expect(o.challenge).toBe('ch');
    expect(o.userVerification).toBe('required');
    expect(o.allowCredentials).toEqual([
      { id: 'a', type: 'public-key' },
      { id: 'b', type: 'public-key' },
    ]);
  });
  test('setup: the engine-issued challenge, platform authenticator, UV required, no attestation', () => {
    const o = registrationOptions({ challenge: 'ch', rpId: 'penny.test', userId: 'dXNlcg' });
    expect(o.rp.id).toBe('penny.test');
    expect(o.authenticatorSelection.userVerification).toBe('required');
    expect(o.attestation).toBe('none');
  });
});
