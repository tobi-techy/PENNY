import { useCallback, useEffect, useState } from 'react';
import { api, apiJson, idem } from './api.ts';
import {
  type ByToken,
  type CardJson,
  closingLine,
  countdown,
  pillFor,
  readCard,
  settledFor,
  styleFor,
} from './cardView.ts';
import { approvalSignMessage } from './chain/delegate.ts';
import { toBase64Url } from './chain/encoding.ts';
import { type ApprovalForSigning, signApproval } from './chain/sign.ts';
import { loadDeviceKey } from './keys/deviceKey.ts';
import { assertPasskey } from './keys/passkey.ts';
import {
  approveMessage,
  boundChallenge,
  type CheckedApproval,
  checkApproval,
  describe,
  unfreezeMessage,
  writeFields,
} from './ticket.ts';

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
  // the approval as this browser checked it (null until checked, or when it doesn't add up)
  const [checked, setChecked] = useState<CheckedApproval | null>(null);
  const [unfreeze, setUnfreeze] = useState<{ challenge: string; passkeys?: string[] } | null>(null);
  // this browser has no Penny key (another browser, a Mac): no dead-end Approve button
  const [noKey, setNoKey] = useState(false);
  // "Not me" switches every key off: ask first
  const [confirmFreeze, setConfirmFreeze] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const raw = await apiJson<{
        card: unknown;
        approval?: ByToken['approval'];
        unfreeze?: { challenge: string; passkeys?: string[] };
      }>(`/v1/approvals/by-token/${token}`);
      const card = readCard(raw.card);
      if (!card) throw new Error('bad card');
      setView({ card, ...(raw.approval ? { approval: raw.approval } : {}) });
      setUnfreeze(raw.unfreeze ?? null);
      setChecked(null);
      if (raw.approval?.challenge && card.state === 'ready') {
        try {
          // never sign what the server says without checking it here first
          setChecked(await checkApproval(raw.approval));
        } catch {
          setErr("This card doesn't add up, so it can't be approved here. Ask Penny again.");
        }
      }
    } catch (e) {
      const status = Number((e as Error).message.replace('http_', ''));
      setErr(
        status === 401 || status === 403
          ? 'This card link has expired. Ask Penny again.'
          : status === 404
            ? "Penny can't find this request anymore."
            : "Couldn't refresh this card. Check your connection and try again.",
      );
    }
  }, [token]);

  useEffect(() => {
    void (async () => {
      setNoKey(!(await loadDeviceKey()));
      // an invest price lasts 90 s: opening the card gets a fresh one in place
      await api(`/v1/approvals/by-token/${token}/fresh-price`, {
        method: 'POST',
        headers: { 'idempotency-key': idem() },
      }).catch(() => null);
      await load();
    })();
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [load, token]);

  // after approving, follow the card until it settles (sent, failed or blocked)
  const approving = view?.card.state === 'approving';
  useEffect(() => {
    if (!approving) return;
    let tries = 0;
    const poll = setInterval(() => {
      tries += 1;
      if (tries > 90) clearInterval(poll); // ~3 min
      void load();
    }, 2000);
    return () => clearInterval(poll);
  }, [approving, load]);

  async function approve() {
    const a = view?.approval;
    const c = checked;
    if (!view || !a || !c) return;
    setBusy(true);
    setErr('');
    try {
      const key = await loadDeviceKey();
      if (!key) {
        setErr('No approval key in this browser yet. Open the setup link Penny sent you first.');
        return;
      }
      const signed = await signApproval(c.detail as unknown as ApprovalForSigning, key);
      // This browser enrolled a key but no passkey (no Touch ID here, or the prompt was
      // cancelled): the key signs the same action this page checked. The server verifies
      // it against the enrolled device key exactly as it does for the phone.
      if (a.passkeys?.length === 0 && a.deviceId && a.challenge) {
        const signature = toBase64Url(
          await key.sign(
            new TextEncoder().encode(approvalSignMessage(a.approvalHash, a.challenge)),
          ),
        );
        const res = await api(`/v1/approvals/${a.id}/sign`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Card ${token}`,
            'idempotency-key': idem(),
          },
          body: JSON.stringify({ deviceId: a.deviceId, signature, ...signed }),
        });
        if (res.status === 423) setErr('Penny is frozen. Text unfreeze to start again.');
        else if (res.status === 410) setErr('This card ran out of time. Tap Get a new card.');
        else if (!res.ok) setErr("I couldn't confirm that. The card below says what happened.");
        await load();
        return;
      }
      // 1) Face ID on this phone (the tap above is what lets Safari start it). The passkey
      //    answers a challenge bound to the approval hash this page checked itself.
      const assertion = await assertPasskey({
        challenge: await boundChallenge(approveMessage(c.approvalHash, c.challenge)),
        rpId: window.location.hostname,
        passkeys: a.passkeys ?? [],
      });
      // 2) this browser's key signs the exact action it checked (and the server checks again)
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
      else if (!res.ok) setErr("I couldn't confirm that. The card below says what happened.");
      await load();
    } catch (e) {
      const name = (e as Error).name;
      const message =
        name === 'ApprovalMismatch'
          ? "This card doesn't add up, so I didn't sign it. Nothing moved. Ask Penny for a new one."
          : name === 'PasskeyCancelled'
            ? 'Face ID was cancelled. Nothing was sent.'
            : name === 'PasskeyUnavailable'
              ? 'This phone has no passkey for Penny. Open the setup link Penny sent you.'
              : "I couldn't confirm that. Check the card before trying again.";
      // the POST may have reached the engine before the reply was lost: re-read it
      await load();
      setErr(message);
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

  async function doUnfreeze(card: CardJson) {
    if (!unfreeze) return;
    setBusy(true);
    setErr('');
    try {
      const assertion = await assertPasskey({
        challenge: await boundChallenge(unfreezeMessage(card.id, unfreeze.challenge)),
        rpId: window.location.hostname,
        passkeys: unfreeze.passkeys ?? [],
      });
      const res = await api(`/v1/cards/by-token/${token}/unfreeze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idem() },
        body: JSON.stringify({ assertion }),
      });
      if (!res.ok)
        setErr("That didn't check out. Penny is still frozen. Text unfreeze for a new card.");
      await load();
    } catch (e) {
      const message =
        (e as Error).name === 'PasskeyCancelled'
          ? 'Face ID was cancelled. Penny is still frozen.'
          : "I couldn't confirm that. Check the card before trying again.";
      // a lost reply may still have unfrozen the card: re-read before saying it failed
      await load();
      setErr(message);
    } finally {
      setBusy(false);
    }
  }

  async function press(card: CardJson, id: string, confirm = false) {
    const b = card.buttons.find((x) => x.id === id);
    if (b?.action === 'freeze' && !confirm) {
      setConfirmFreeze(id);
      return;
    }
    if (b?.action === 'freeze') {
      setConfirmFreeze(null);
      const res = await post(`/v1/cards/by-token/${token}/press`, { buttonId: id, confirm: true });
      if (res?.ok)
        setMsg('Penny is frozen. Every key is off. Text unfreeze when you want it back.');
      await load();
      return;
    }
    if (b?.action === 'unfreeze') {
      await doUnfreeze(card);
      return;
    }
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
    const body = (await res?.json().catch(() => null)) as { approvalId?: string | null } | null;
    // only say a card is coming when one was actually made
    if (res?.ok && body?.approvalId) setMsg('A new card is on its way to Messages.');
    else setErr("Penny couldn't make a new card. Ask Penny again in Messages.");
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
  const pill = card.kind === 'approval' ? pillFor(state, card.type) : null;
  const closing = card.statusLine ?? closingLine(state);
  // the same test approve() uses: no passkey in this browser, so the enrolled device key signs
  const deviceKey = view?.approval?.passkeys?.length === 0 && Boolean(view.approval.deviceId);

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

          {state === 'ready' && card.kind === 'approval' && checked && (
            <div className="approving">
              <div className="what">{describe(checked)}</div>
              {writeFields(checked).map((f) => (
                <div className="field" key={f.key}>
                  <span>{f.key}</span>
                  <pre>{f.value}</pre>
                </div>
              ))}
            </div>
          )}
          {state === 'ready' && card.kind === 'approval' && noKey && (
            <p className="note">
              This browser isn't the one you set up Penny on, so it can't approve. Open this card on
              that phone (the same message is there), or ask Penny to send it again.
            </p>
          )}
          {state === 'ready' && card.kind === 'approval' && !noKey && (
            <>
              <button type="button" className="pill" disabled={busy || !checked} onClick={approve}>
                {busy ? 'Approving…' : pill}
              </button>
              <button type="button" className="pill dim" disabled={busy} onClick={decline}>
                Not now
              </button>
            </>
          )}
          {state === 'approving' && <div className="pill dim">{pill}</div>}
          {state === 'sent' && <div className="pill ok">✓ {pill}</div>}
          {state === 'done' && card.kind === 'approval' && <div className="pill ok">✓ {pill}</div>}
          {state === 'expired' && card.kind === 'approval' && (
            <button type="button" className="pill dim" disabled={busy} onClick={renew}>
              {pill}
            </button>
          )}
          {confirmFreeze && (
            <div className="confirm">
              <p>Freeze Penny? Every key is switched off and every open card is cancelled.</p>
              <button
                type="button"
                className="pill red"
                disabled={busy}
                onClick={() => press(card, confirmFreeze, true)}
              >
                Yes, freeze everything
              </button>
              <button type="button" className="pill dim" onClick={() => setConfirmFreeze(null)}>
                Cancel
              </button>
            </div>
          )}
          {blocked && !confirmFreeze && card.buttons.length > 0 && (
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
                  className={b.action === 'unfreeze' ? 'pill' : 'pill dim'}
                  disabled={busy}
                  onClick={() => press(card, b.id)}
                >
                  {b.label}
                </button>
              ))}
            </div>
          )}
          {card.kind === 'info' && state === 'done' && card.buttons.length === 0 && (
            <div className="pill ok">✓ {settledFor(card.type)}</div>
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
        <p>
          {deviceKey
            ? "Approving uses the key this browser enrolled. Penny's server never holds it."
            : "Approving uses Face ID on this phone. Penny's server never holds your key."}
        </p>
      )}
    </main>
  );
}
