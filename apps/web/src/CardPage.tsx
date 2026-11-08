import { useCallback, useEffect, useState } from 'react';
import { api, apiJson, idem } from './api.ts';
import {
  type ByToken,
  type CardJson,
  closingLine,
  countdown,
  pillFor,
  readCard,
  styleFor,
} from './cardView.ts';
import { type ApprovalForSigning, signApproval } from './chain/sign.ts';
import { describeAction, passkeyChallengeFor, verifyApproval } from './chain/verify.ts';
import { loadDeviceKey } from './keys/deviceKey.ts';
import { assertPasskey } from './keys/passkey.ts';

/**
 * The link card page (/a/<cardToken>): the same card as the iMessage extension. Approving
 * takes a tap ("Approve with Face ID"); Safari only starts Face ID from a tap. The passkey
 * assertion is checked on the server, then the action signed by this browser's key is relayed.
 */
export function CardPage({ token }: { token: string }) {
  const [view, setView] = useState<ByToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [now, setNow] = useState(Date.now());
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const raw = await apiJson<{ card: unknown; approval?: ByToken['approval'] }>(
        `/v1/approvals/by-token/${token}`,
      );
      const card = readCard(raw.card);
      if (!card) throw new Error('bad card');
      setView({ card, ...(raw.approval ? { approval: raw.approval } : {}) });
    } catch {
      setErr('This card is gone. Ask Penny for a fresh one.');
    }
  }, [token]);

  useEffect(() => {
    void load();
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [load]);

  // What the passkey will cover, derived from the verified plan (never from server text).
  const [approving, setApproving] = useState<string | null>(null);
  useEffect(() => {
    const a = view?.approval;
    if (!a) {
      setApproving(null);
      return;
    }
    verifyApproval(a)
      .then((x) => setApproving(describeAction(x)))
      .catch(() => setApproving(''));
  }, [view]);

  async function approve() {
    const a = view?.approval;
    if (!view || !a?.challenge) return;
    setBusy(true);
    setErr('');
    try {
      const key = await loadDeviceKey();
      if (!key) {
        setErr('No approval key in this browser yet. Open the setup link Penny sent you first.');
        return;
      }
      // 0) check the approval hangs together before anything is signed (same as iPhone)
      await verifyApproval(a);
      // 1) Face ID on this phone (the tap above is what lets Safari start it)
      const assertion = await assertPasskey({
        challenge: await passkeyChallengeFor(a.approvalHash, a.challenge),
        rpId: window.location.hostname,
        passkeys: a.passkeys ?? [],
      });
      // 2) this browser's key signs the exact action (checked byte for byte on the server)
      const signed = await signApproval(a.detail as ApprovalForSigning, key);
      const res = await api(`/v1/approvals/${a.id}/passkey`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Card ${token}`,
          'idempotency-key': idem(),
        },
        body: JSON.stringify({ assertion, ...signed }),
      });
      if (res.status === 423) setErr('Penny is frozen. Text unfreeze to start again.');
      else if (res.status === 410) setErr('This card ran out of time. Tap Get a new card.');
      else if (!res.ok) setErr("That didn't check out. Nothing moved. Penny sent you a new card.");
      await load();
    } catch (e) {
      const name = (e as Error).name;
      setErr(
        name === 'ApprovalMismatch'
          ? "This card doesn't add up, so I didn't sign it. Nothing moved. Ask Penny for a new one."
          : name === 'PasskeyCancelled'
            ? 'Face ID was cancelled. Nothing was sent.'
            : name === 'PasskeyUnavailable'
              ? 'This phone has no passkey for Penny. Open the setup link Penny sent you.'
              : "That didn't go through. Nothing moved.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function post(path: string, body: unknown) {
    setBusy(true);
    setErr('');
    try {
      const res = await api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idem() },
        body: JSON.stringify(body),
      });
      if (!res.ok) setErr("That didn't work. Try again.");
      return res;
    } finally {
      setBusy(false);
    }
  }

  async function press(card: CardJson, id: string) {
    const b = card.buttons.find((x) => x.id === id);
    if (b?.action === 'open' && b.value?.startsWith('https://')) {
      window.location.href = b.value;
      return;
    }
    if (b?.action === 'edit') {
      const res = await post(`/v1/cards/by-token/${token}/press`, { buttonId: id });
      const body = (await res?.json().catch(() => null)) as { editable?: { value: string } } | null;
      setEditing(body?.editable?.value ?? '');
      return;
    }
    await post(`/v1/cards/by-token/${token}/press`, { buttonId: id });
    await load();
  }

  async function saveEdit() {
    if (editing === null) return;
    await post(`/v1/cards/by-token/${token}/edit`, { text: editing });
    setEditing(null);
    await load();
  }

  async function renew() {
    const res = await post(`/v1/approvals/by-token/${token}/renew`, {});
    if (res?.ok) setMsg('A new card is on its way to Messages.');
  }

  async function decline() {
    const a = view?.approval;
    if (!a) return;
    setBusy(true);
    try {
      await api(`/v1/approvals/${a.id}/decline`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Card ${token}`,
          'idempotency-key': idem(),
        },
        body: '{}',
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!view) {
    return (
      <main>
        <p className={err ? 'err' : ''}>{err || 'Loading…'}</p>
      </main>
    );
  }
  const { card } = view;
  const style = styleFor(card.type);
  const blocked = card.state === 'blocked' || card.type === 'guard_block';
  const live = card.kind === 'approval' && card.state === 'ready';
  const expired = live && card.expiresAt !== undefined && Date.parse(card.expiresAt) <= now;
  const state = expired ? 'expired' : card.state;
  const pill = card.kind === 'approval' ? pillFor(state) : null;
  const closing = closingLine(state);

  return (
    <main>
      <article className="pcard" aria-label={card.title}>
        <div
          className={`art ${state === 'sent' || state === 'done' ? 'calm' : ''} ${state === 'expired' ? 'muted' : ''}`}
          data-type={blocked ? 'guard_block' : style.known ? card.type : 'plain'}
          aria-hidden="true"
        />
        <div className="body">
          <div className="tagrow">
            <span className={`tag ${blocked ? 'red' : ''}`}>{blocked ? 'BLOCKED' : style.tag}</span>
            <span className="timer">{live && !expired ? countdown(card.expiresAt, now) : ''}</span>
          </div>
          {card.amount ? (
            <>
              <div className="meta">{card.title}</div>
              <div className="amt">{card.amount}</div>
            </>
          ) : (
            <div className="headline">{card.title}</div>
          )}
          {card.lines.length > 0 && (
            <div className="dl">
              {card.lines.map((l) => (
                <div key={`${l.label ?? ''}:${l.value}`}>
                  {l.label ? <span>{l.label}</span> : null}
                  <b>{l.value}</b>
                </div>
              ))}
            </div>
          )}

          {state === 'ready' && card.kind === 'approval' && approving !== null && (
            <p className={approving ? 'approving' : 'err'}>
              {approving
                ? `You're approving: ${approving}`
                : "This card doesn't add up, so it can't be approved. Ask Penny for a new one."}
            </p>
          )}
          {state === 'ready' && card.kind === 'approval' && (
            <>
              <button type="button" className="pill" disabled={busy} onClick={approve}>
                {busy ? 'Approving…' : pill}
              </button>
              <button type="button" className="pill dim" disabled={busy} onClick={decline}>
                Not now
              </button>
            </>
          )}
          {state === 'approving' && <div className="pill dim">{pill}</div>}
          {state === 'sent' && <div className="pill ok">✓ {pill}</div>}
          {state === 'expired' && card.kind === 'approval' && (
            <button type="button" className="pill dim" disabled={busy} onClick={renew}>
              {pill}
            </button>
          )}
          {blocked && card.buttons.length > 0 && (
            <button
              type="button"
              className="pill red"
              disabled={busy}
              onClick={() => press(card, card.buttons[0]?.id ?? 'notme')}
            >
              {card.buttons[0]?.label ?? 'Not me'}
            </button>
          )}
          {!blocked && card.kind === 'info' && card.state !== 'undone' && (
            <div className="buttons">
              {card.buttons.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="pill dim"
                  disabled={busy}
                  onClick={() => press(card, b.id)}
                >
                  {b.label}
                </button>
              ))}
            </div>
          )}
          {editing !== null && (
            <div className="edit">
              <textarea
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                aria-label="Message"
                rows={6}
              />
              <button type="button" className="pill" disabled={busy} onClick={saveEdit}>
                Save
              </button>
            </div>
          )}
          {card.receiptUrl && (
            <a className="foot" href={card.receiptUrl} rel="noreferrer">
              View receipt ›
            </a>
          )}
        </div>
      </article>
      {closing && <p>{closing}</p>}
      {msg && <p className="ok">{msg}</p>}
      {err && <p className="err">{err}</p>}
      {card.kind === 'approval' && state === 'ready' && (
        <p>Approving uses Face ID on this phone. Penny's server never holds your key.</p>
      )}
    </main>
  );
}
