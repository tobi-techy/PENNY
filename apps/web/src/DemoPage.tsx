import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiJson, b64url, idem } from './api.ts';
import { CardPage } from './CardPage.tsx';
import { createDeviceKey, loadDeviceKey } from './keys/deviceKey.ts';
import { createPasskey, passkeySupported } from './keys/passkey.ts';
import './demo.css';

type Msg = {
  seq: number;
  direction: 'inbound' | 'outbound';
  kind: 'text' | 'card' | 'typing';
  text: string | null;
  url: string | null;
  cardId: string | null;
};

type Prompt = { label: string; text: string; note: string };

type Start = {
  sessionId: string;
  enrollCode: string;
  accountId: string;
  prompts: Prompt[];
  policy?: { perTxUsd: string; dailyUsd: string; blockNewRecipientsOverUsd: string };
  guard?: { contractId: string; explorer: string };
  live: string[];
  simulated: string[];
};

const SESSION_KEY = 'penny.demo.session';
/** Which check this browser enrolled with: passkey (Face ID) or the device key. */
const MODE_KEY = 'penny.demo.mode';
const tokenOf = (url: string) => /\/a\/([A-Za-z0-9_-]{43})/.exec(url)?.[1] ?? url;

/**
 * The public demo thread. It looks and behaves like the message thread Penny lives
 * in: the same incoming bubbles, the same typing indicator, and the same card picture
 * the phone gets (the engine's own /a/<token>/card.png). Tapping a card opens the real
 * card page, where Face ID and the signature checks run exactly as they do in Messages.
 */
export function DemoPage() {
  const [start, setStart] = useState<Start | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [busy, setBusy] = useState<'start' | 'send' | null>(null);
  const [note, setNote] = useState('');
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<'unknown' | 'passkey' | 'device'>('unknown');
  const [film, setFilm] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (sessionId: string) => {
    try {
      const r = await apiJson<{ messages: Msg[] }>(`/v1/demo/thread?session=${sessionId}`);
      setMessages(r.messages);
    } catch {
      localStorage.removeItem(SESSION_KEY);
      setStart(null);
      setMessages([]);
      setNote('That demo session expired. Start a new one.');
    }
  }, []);

  // A reload keeps the same throwaway thread: the session payload is in localStorage.
  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    try {
      const s = JSON.parse(raw) as Start;
      setStart(s);
      setApprovals(localStorage.getItem(MODE_KEY) === 'passkey' ? 'passkey' : 'device');
      void load(s.sessionId);
    } catch {
      localStorage.removeItem(SESSION_KEY);
    }
  }, [load]);

  // The film is served only when the deployment carries one; never a broken video tag.
  useEffect(() => {
    void (async () => {
      try {
        const r = await api('/demo/film.mp4', { method: 'HEAD' });
        if (r.ok) setFilm('/demo/film.mp4');
      } catch {
        /* no film, no link */
      }
    })();
  }, []);

  // Keep the newest bubble in view. messages and busy are the trigger, not inputs:
  // the ref is stable, so the effect only needs to run when the thread changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only dependencies
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, busy]);

  // Approving happens inside the card sheet, not by sending a message, so keep the
  // thread fresh while it is open: the server closes the card on each read.
  useEffect(() => {
    if (!open || !start) return;
    const t = setInterval(() => void load(start.sessionId), 2_000);
    return () => clearInterval(t);
  }, [open, start, load]);

  /** Start a session: a throwaway user, this browser's key, and Face ID if it has one. */
  async function begin() {
    setBusy('start');
    setNote('');
    try {
      const s = await apiJson<Start>('/v1/demo/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      setStart(s);
      const mode = await enroll(s);
      // Remembered so a reload keeps telling the truth about which check this browser uses.
      if (mode !== 'off') localStorage.setItem(MODE_KEY, mode);
      setApprovals(mode === 'off' ? 'device' : mode);
    } catch {
      setNote('Could not open a demo session. Try again in a moment.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Link this browser to the demo user. A passkey is preferred (it is the same Face ID
   * check the phone does); a browser without one signs with its device key instead, so
   * the demo never dead-ends on a desktop.
   */
  async function enroll(s: Start): Promise<'passkey' | 'device' | 'off'> {
    try {
      const key = (await loadDeviceKey()) ?? (await createDeviceKey());
      let passkey: Record<string, unknown> = {};
      if (await passkeySupported().catch(() => false)) {
        const res = await api('/v1/devices/passkey/challenge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enrollCode: s.enrollCode }),
        });
        if (res.ok) {
          const c = (await res.json()) as {
            challengeId: string;
            challenge: string;
            rpId: string;
            userId: string;
          };
          passkey = { passkey: await createPasskey(c), passkeyChallengeId: c.challengeId };
        }
      }
      const res = await api('/v1/demo/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idem() },
        body: JSON.stringify({
          sessionId: s.sessionId,
          enrollCode: s.enrollCode,
          publicKeyEd25519: b64url(key.publicKey),
          ...passkey,
        }),
      });
      // Say which check this browser will actually be asked for, not the one we hoped for.
      if (!res.ok) return 'off';
      return passkey.passkey ? 'passkey' : 'device';
    } catch {
      return 'off';
    }
  }

  async function say(text: string) {
    if (!start || !text.trim() || busy === 'send') return;
    setDraft('');
    setBusy('send');
    setNote('');
    try {
      const r = await apiJson<{ messages: Msg[]; turns: number; maxTurns: number }>(
        '/v1/demo/say',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': idem() },
          body: JSON.stringify({ sessionId: start.sessionId, text }),
        },
      );
      setMessages(r.messages);
      if (r.turns >= r.maxTurns)
        setNote('That is all the turns for this session. Reload to start a fresh one.');
    } catch (e) {
      const status = Number((e as Error).message.replace('http_', ''));
      setNote(
        status === 429
          ? 'One at a time. Give it a second.'
          : 'That turn did not go through. Try again.',
      );
      await load(start.sessionId);
    } finally {
      setBusy(null);
    }
  }

  /** One card per token: a link card is re-sent when its state changes. */
  const items = useMemo(() => {
    const out: Msg[] = [];
    const at = new Map<string, number>();
    for (const m of messages) {
      if (m.kind === 'card' && m.url) {
        const tok = tokenOf(m.url);
        const seen = at.get(tok);
        if (seen !== undefined) {
          out[seen] = m;
          continue;
        }
        at.set(tok, out.length);
      }
      out.push(m);
    }
    return out;
  }, [messages]);

  if (!start) {
    return (
      <div className="im">
        <header className="im-head">
          <div className="im-name">
            <span className="im-dot" aria-hidden="true" />
            Penny
          </div>
          <div className="im-sub">demo · NEAR testnet</div>
        </header>
        <div className="im-body im-intro">
          <p className="im-lead">
            This is Penny&apos;s engine, running now. The Guard, the approval, the signature check
            and the cards are real. The account is a throwaway, so nothing is ever sent.
          </p>
          <button type="button" className="im-cta" onClick={begin} disabled={busy === 'start'}>
            {busy === 'start' ? 'Opening…' : 'Open the demo thread'}
          </button>
          {note && <p className="im-note">{note}</p>}
          <p className="im-fine">
            No install and no phone number. If this browser has a passkey you will be asked for Face
            ID or Touch ID, the same check Penny does in Messages.
          </p>
          {film && (
            <a className="im-film" href={film} target="_blank" rel="noreferrer noopener">
              Or watch the 60 second film
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="im">
      <header className="im-head">
        <div className="im-name">
          <span className="im-dot" aria-hidden="true" />
          Penny
        </div>
        <div className="im-sub">
          {start.accountId} · {approvals === 'passkey' ? 'Face ID' : 'device key'}
        </div>
      </header>

      <div className="im-strip">
        Live: {start.live.join(' · ')}. Not live: {start.simulated.join(' · ')}.
        {start.guard && (
          <>
            {' '}
            <a href={start.guard.explorer} target="_blank" rel="noreferrer noopener">
              {start.guard.contractId}
            </a>
          </>
        )}
      </div>

      {start.policy && (
        <div className="im-limits">
          <b>Guard</b> ${start.policy.perTxUsd} per send · ${start.policy.dailyUsd} a day · new
          recipients over ${start.policy.blockNewRecipientsOverUsd}
        </div>
      )}

      <div className="im-body">
        <div className="im-stamp">Today</div>
        {items.length === 0 && (
          <div className="im-hint">Try one of these. Each one goes through the real code path.</div>
        )}
        {items.map((m) => {
          if (m.kind === 'card' && m.url) {
            const url = m.url;
            return (
              <button
                type="button"
                key={m.seq}
                className="im-card"
                onClick={() => setOpen(tokenOf(url))}
              >
                <img src={`${url}/card.png`} alt="Penny card" />
                <span className="im-card-tap">
                  {approvals === 'passkey' ? 'Open to review · Face ID' : 'Open to review'}
                </span>
              </button>
            );
          }
          return (
            <div key={m.seq} className={`im-row ${m.direction === 'outbound' ? 'in' : 'out'}`}>
              <div className="im-bubble">{m.text}</div>
            </div>
          );
        })}
        {busy === 'send' && (
          <div className="im-row in">
            <div className="im-bubble im-typing" role="status" aria-label="Penny is typing">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="im-chips">
        {start.prompts.map((p) => (
          <button
            type="button"
            key={p.text}
            className="im-chip"
            title={p.note}
            onClick={() => say(p.text)}
            disabled={busy === 'send'}
          >
            {p.label}
          </button>
        ))}
      </div>

      <form
        className="im-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void say(draft);
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Text Penny"
          aria-label="Message"
          maxLength={400}
        />
        <button type="submit" aria-label="Send" disabled={!draft.trim() || busy === 'send'}>
          ↑
        </button>
      </form>

      {note && <div className="im-note">{note}</div>}

      {open && (
        <div className="im-sheet">
          <button type="button" className="im-close" onClick={() => setOpen(null)}>
            Close
          </button>
          <CardPage token={open} />
        </div>
      )}
    </div>
  );
}
