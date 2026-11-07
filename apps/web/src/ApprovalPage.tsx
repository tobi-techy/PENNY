import { useEffect, useState } from 'react';
import { apiJson, idem } from './api.ts';
import { type ApprovalForSigning, approvalDigest, signApproval } from './chain/sign.ts';
import { loadDeviceKey } from './keys/deviceKey.ts';
import { confirmWithPasskey, hasPasskey } from './keys/passkey.ts';

interface ApprovalDto extends ApprovalForSigning {
  title: string;
  amountDisplay: string;
  facts: { label: string; value: string }[];
  status: string;
  expiresAt: string;
}

function tokenFromHash(): string {
  const m = /t=([A-Za-z0-9_-]{20,})/.exec(window.location.hash);
  return m?.[1] ?? '';
}

/** Approval page: the no-install card. Signs with this browser's key, behind its passkey. */
export function ApprovalPage({ id }: { id: string }) {
  const [dto, setDto] = useState<ApprovalDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const token = tokenFromHash();

  useEffect(() => {
    apiJson<ApprovalDto>(`/v1/approvals/${id}`, {
      headers: { authorization: `Card ${token}` },
    })
      .then(setDto)
      .catch(() => setErr('This link did not work. Ask Penny for a fresh one.'));
  }, [id, token]);

  async function act(path: 'submit' | 'decline') {
    if (!dto) return;
    setBusy(true);
    setErr('');
    try {
      let body: unknown = {};
      if (path === 'submit') {
        const key = await loadDeviceKey();
        if (!key) {
          setErr('No approval key in this browser yet. Open the setup link Penny sent you first.');
          return;
        }
        if (await hasPasskey()) await confirmWithPasskey(await approvalDigest(dto, key.publicKey));
        body = await signApproval(dto, key);
      }
      const res = await apiJson<{ status: string }>(`/v1/approvals/${id}/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Card ${token}`,
          'idempotency-key': idem(),
        },
        body: JSON.stringify(body),
      });
      setDto({ ...dto, status: res.status });
      setMsg(res.status === 'settled' ? 'Done. Penny has it from here.' : `Status: ${res.status}`);
    } catch (e) {
      setErr(
        (e as Error).name === 'PasskeyCancelled'
          ? 'Passkey cancelled. Nothing was approved.'
          : 'That did not go through. Nothing was changed — ask Penny to try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (err && !dto)
    return (
      <main>
        <h1>Penny</h1>
        <p className="err">{err}</p>
      </main>
    );
  if (!dto)
    return (
      <main>
        <h1>Penny</h1>
        <p>Loading…</p>
      </main>
    );
  const terminal = ['settled', 'failed', 'expired', 'cancelled'].includes(dto.status);
  return (
    <main>
      <h1>{dto.title}</h1>
      <div className="amount">{dto.amountDisplay}</div>
      <div className="card">
        {dto.facts.map((f) => (
          <div className="fact" key={f.label}>
            <span>{f.label}</span>
            <span>{f.value}</span>
          </div>
        ))}
        <div className="fact">
          <span>Status</span>
          <span>{dto.status}</span>
        </div>
      </div>
      {!terminal && (
        <>
          <button type="button" className="primary" disabled={busy} onClick={() => act('submit')}>
            {busy ? 'Working…' : 'Approve'}
          </button>
          <button type="button" className="plain" disabled={busy} onClick={() => act('decline')}>
            No, don't
          </button>
        </>
      )}
      {msg && <p className="ok">{msg}</p>}
      {err && <p className="err">{err}</p>}
      <p>Approving signs with the key in this browser. Penny's server never holds your key.</p>
    </main>
  );
}
