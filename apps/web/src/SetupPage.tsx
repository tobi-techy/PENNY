import { useEffect, useState } from 'react';
import { api, b64url, idem } from './api.ts';
import { createDeviceKey, loadDeviceKey } from './keys/deviceKey.ts';
import { createPasskey, passkeySupported } from './keys/passkey.ts';

function codeFromHash(): string {
  const m = /code=([A-Za-z0-9]{4,16})/.exec(window.location.hash);
  return m?.[1]?.toUpperCase() ?? '';
}

/** No-install setup: make this browser's approval key and link it to your Penny. */
export function SetupPage() {
  const [code, setCode] = useState(codeFromHash);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle');
  const [note, setNote] = useState('');

  useEffect(() => {
    void loadDeviceKey().then((k) => {
      if (k) setNote('This browser already has a Penny key.');
    });
  }, []);

  async function setup() {
    setBusy(true);
    setState('idle');
    try {
      const key = (await loadDeviceKey()) ?? (await createDeviceKey());
      if (await passkeySupported()) {
        try {
          await createPasskey('Penny');
        } catch {
          /* passkey is a gate, not a requirement */
        }
      }
      const res = await api('/v1/devices/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idem() },
        body: JSON.stringify({
          enrollCode: code.trim().toUpperCase(),
          publicKeyEd25519: b64url(key.publicKey),
        }),
      });
      if (res.status === 201) {
        setState('done');
      } else if (res.status === 409) {
        setNote(
          'This Penny is already linked to another device. Ask Penny in Messages what to do.',
        );
        setState('error');
      } else if (res.status === 401 || res.status === 400) {
        setNote(
          'That code did not work. Codes last 10 minutes and work once — text Penny for a fresh link.',
        );
        setState('error');
      } else {
        setNote(`Something went wrong (${res.status}). Try again.`);
        setState('error');
      }
    } catch (e) {
      if ((e as Error).name === 'NoSecureKeyStore') {
        setNote(
          'This browser cannot keep a safe approval key. Use the Penny app on your iPhone instead — text Penny and tap the setup card.',
        );
      } else {
        setNote('Could not reach Penny. Check your connection and try again.');
      }
      setState('error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Link this browser to Penny</h1>
      <p>
        Penny helps with the everyday stuff — inbox, bills, errands, money. This makes an approval
        key in this browser, locked behind your passkey or Face ID on this device. Nothing to
        install; the key never leaves this browser.
      </p>
      <div className="card">
        <p>Your one-time code (Penny texted you a link with it filled in):</p>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="ABCDEFGH"
          maxLength={16}
          aria-label="One-time code"
        />
        <button
          type="button"
          className="primary"
          disabled={busy || code.trim().length < 8}
          onClick={setup}
        >
          {busy ? 'Linking…' : 'Link this browser'}
        </button>
        {note && <p className={state === 'error' ? 'err' : ''}>{note}</p>}
        {state === 'done' && (
          <p className="ok">You're set. Go back to Messages and ask Penny again.</p>
        )}
      </div>
    </main>
  );
}
