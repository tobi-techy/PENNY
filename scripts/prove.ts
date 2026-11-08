/**
 * bun run prove — end-to-end proof of the approval path, written to PROOF.md.
 *
 * Remote (the real proof): against a deployed engine on NEAR testnet.
 *   PUBLIC_BASE_URL=https://<engine>        the deployed engine (NEAR_NETWORK=testnet, DRY_RUN=0)
 *   PENNY_PROVE_SECRET=<same as the engine> turns on its testnet-only proof routes
 *   PENNY_PROVE_ACCOUNT_ID=<x>.testnet      a funded testnet account (test money only)
 *   PENNY_PROVE_PRIVATE_KEY=ed25519:<...>   that account's full-access TEST key (never a real key)
 *   PENNY_PROVE_TO=<y>.testnet              optional recipient (default: the account itself)
 *
 * Local (no PUBLIC_BASE_URL, or --local): the same steps against an in-process engine with
 * the fake chain (dry run). Every server check runs; there are no transaction links.
 *
 * Steps: TEE attestation, 0.1 NEAR approval signed with the test key and settled, the
 * same signature reused (must be refused), an over-limit send (Guard must block it, no
 * approval card), a signature from the wrong key (must be refused, card re-issued).
 * Never point this at mainnet: it refuses unless the engine says it is on testnet.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { type ApprovalForSigning, signApproval } from '../apps/web/src/chain/sign.ts';
import { fromBase58 } from '../packages/chain/src/util/encoding.ts';
import {
  approvalActionOf,
  approvalHash,
  approvalSignMessage,
  type IntentPlan,
} from '../packages/shared/src/index.ts';

type Check = { name: string; ok: boolean; detail: string; link?: string };
const checks: Check[] = [];
const record = (c: Check) => {
  checks.push(c);
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}${c.link ? ` ${c.link}` : ''}`);
};

const args = new Set(process.argv.slice(2));
const remote = Boolean(process.env.PUBLIC_BASE_URL) && !args.has('--local');
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

async function setup(): Promise<{
  call: Fetch;
  base: string;
  secret: string;
  accountId: string;
  seed: Uint8Array;
  to: string;
  explorer: string;
  done: () => Promise<void>;
}> {
  if (remote) {
    const base = (process.env.PUBLIC_BASE_URL as string).replace(/\/$/, '');
    const secret = process.env.PENNY_PROVE_SECRET ?? '';
    const accountId = process.env.PENNY_PROVE_ACCOUNT_ID ?? '';
    const pk = process.env.PENNY_PROVE_PRIVATE_KEY ?? '';
    if (!secret || !accountId.endsWith('.testnet') || !pk.startsWith('ed25519:')) {
      console.error(
        'remote proof needs PENNY_PROVE_SECRET, PENNY_PROVE_ACCOUNT_ID (*.testnet) and PENNY_PROVE_PRIVATE_KEY (ed25519:...)',
      );
      process.exit(2);
    }
    const raw = fromBase58(pk.slice('ed25519:'.length));
    return {
      call: (path, init) => fetch(`${base}${path}`, init),
      base,
      secret,
      accountId,
      seed: raw.slice(0, 32),
      to: process.env.PENNY_PROVE_TO ?? accountId,
      explorer: 'https://testnet.nearblocks.io/txns/',
      done: async () => {},
    };
  }
  // Local: an in-process engine (pglite + fake chain, dry run).
  const { createEngine } = await import('../apps/engine/src/app.ts');
  const { createPgliteDb } = await import('../apps/engine/src/db/client.ts');
  const { FakeChain } = await import('../apps/engine/src/ports/chain.ts');
  const { FakeMessaging } = await import('../apps/engine/src/ports/messaging.ts');
  const { createRegistry, FakeMarket } = await import('../apps/engine/src/brain/tools.ts');
  const { FakeEmbedder } = await import('../apps/engine/src/brain/memory.ts');
  const { createLogger } = await import('../apps/engine/src/lib/logger.ts');
  const db = await createPgliteDb();
  // the proof never talks to the model: approvals come from the proof route
  const model = {} as never;
  const secret = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const base = 'https://penny.local';
  const engine = createEngine({
    db: db.db,
    chain: new FakeChain(),
    messaging: new FakeMessaging(),
    models: { router: model, chat: model },
    embedder: new FakeEmbedder(),
    market: new FakeMarket(),
    registry: createRegistry(),
    log: createLogger('silent'),
    publicBaseUrl: base,
    webhookSecret: undefined,
    limits: { perIpPerMin: 1000, perUserPerMin: 1000, maxBodyBytes: 65_536 },
    proveSecret: secret,
  });
  await engine.services.bots.seedBuiltIns(join(import.meta.dir, '..', 'souls'));
  return {
    call: (path, init) => Promise.resolve(engine.app.request(path, init)),
    base,
    secret,
    accountId: 'proof.penny.near',
    seed: crypto.getRandomValues(new Uint8Array(32)),
    to: 'amara.penny.near',
    explorer: '',
    done: () => db.close(),
  };
}

const env = await setup();
const pub = ed25519.getPublicKey(env.seed);
const signer = { publicKey: pub, sign: async (m: Uint8Array) => ed25519.sign(m, env.seed) };
const auth = { authorization: `Bearer ${env.secret}`, 'content-type': 'application/json' };
const idem = () => `prove_${crypto.randomUUID().replaceAll('-', '')}`;
const json = async (r: Response) => (await r.json().catch(() => ({}))) as Record<string, unknown>;

// 0. TEE attestation (public, no user data)
{
  const r = await env.call('/v1/attestation');
  const body = await json(r);
  record({
    name: 'TEE attestation',
    ok: r.status === 200,
    detail: `mode=${String(body.mode ?? 'off')} verified=${String(body.verified ?? false)}${body.label ? ` (${String(body.label)})` : ''}`,
  });
}

// 1. bind the prove account to the test device key
const enroll = await env.call('/v1/prove/enroll', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ accountId: env.accountId, publicKeyEd25519: b64u(pub) }),
});
const { deviceId } = (await json(enroll)) as { deviceId?: string };
if (!deviceId) {
  console.error(
    `proof routes unavailable (HTTP ${enroll.status}). Is PENNY_PROVE_SECRET set on the engine?`,
  );
  process.exit(2);
}

async function newApproval(amount: string) {
  const plan: IntentPlan = { kind: 'send', asset: 'NEAR', amount, to: env.to };
  const r = await env.call('/v1/prove/approval', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ accountId: env.accountId, plan }),
  });
  return (await json(r)) as {
    decision: string;
    reasons?: string[];
    approvalId?: string;
    cardToken?: string;
  };
}

async function signBody(token: string, key = signer) {
  const view = (await json(await env.call(`/v1/approvals/by-token/${token}`))) as {
    approval: {
      id: string;
      approvalHash: string;
      challenge?: string;
      expiresAt: string;
      detail: ApprovalForSigning & { plan: IntentPlan };
    };
  };
  const a = view.approval;
  // the phone never trusts the server's hash: recompute it from the plan it signs
  const local = approvalHash({
    id: a.id,
    action: approvalActionOf(a.detail.plan),
    expiresAt: a.expiresAt,
    planHash: a.detail.planHash,
  });
  if (local !== a.approvalHash) throw new Error('approval hash mismatch');
  const msg = new TextEncoder().encode(approvalSignMessage(a.approvalHash, a.challenge ?? ''));
  const signed = await signApproval(a.detail, key);
  return {
    id: a.id,
    body: { deviceId, signature: b64u(await key.sign(msg)), ...signed },
  };
}

const sign = (id: string, token: string, body: unknown) =>
  env.call(`/v1/approvals/${id}/sign`, {
    method: 'POST',
    headers: {
      authorization: `Card ${token}`,
      'idempotency-key': idem(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

// 2. a 0.1 NEAR send: approval card, signed with the test key, relayed, settled
const first = await newApproval('0.1');
let firstBody: unknown = null;
if (first.decision !== 'allow_with_approval' || !first.approvalId || !first.cardToken) {
  record({
    name: 'Send 0.1 NEAR settles',
    ok: false,
    detail: `no approval: ${(first.reasons ?? []).join(' ')}`,
  });
} else {
  const s = await signBody(first.cardToken);
  firstBody = s.body;
  const res = await sign(first.approvalId, first.cardToken, s.body);
  let status = String((await json(res)).status ?? res.status);
  let txHash: string | null = null;
  for (let i = 0; i < 45 && status !== 'settled' && status !== 'failed'; i += 1) {
    await new Promise((r) => setTimeout(r, 2_000));
    const st = await json(
      await env.call(`/v1/approvals/${first.approvalId}/status`, {
        headers: { authorization: `Card ${first.cardToken}` },
      }),
    );
    status = String(st.status);
    txHash = (st.txHash as string | null) ?? null;
  }
  if (!txHash) {
    const st = await json(
      await env.call(`/v1/approvals/${first.approvalId}/status`, {
        headers: { authorization: `Card ${first.cardToken}` },
      }),
    );
    txHash = (st.txHash as string | null) ?? null;
  }
  const dry = !txHash || txHash.startsWith('dry_');
  record({
    name: 'Send 0.1 NEAR settles',
    ok: status === 'settled',
    detail: `status=${status}${dry ? ' (dry run: no transaction)' : ''}`,
    ...(txHash && !dry && env.explorer ? { link: `${env.explorer}${txHash}` } : {}),
  });
}

// 3. the same signature again: refused, nothing relayed twice
if (first.approvalId && first.cardToken && firstBody) {
  const again = await sign(first.approvalId, first.cardToken, firstBody);
  record({
    name: 'Reused signature is refused',
    ok: again.status === 409,
    detail: `HTTP ${again.status} ${String((await json(again)).error ?? '')}`,
  });
}

// 4. over the limit: Guard blocks it before any approval card
{
  const big = await newApproval('5000');
  record({
    name: 'Over-limit send is blocked by Guard (no approval card)',
    ok: big.decision === 'block' && !big.approvalId,
    detail: `decision=${big.decision}: ${(big.reasons ?? []).join(' ')}`,
  });
}

// 5. a signature from a key that is not the enrolled one: refused, card re-issued
{
  const c = await newApproval('0.1');
  if (c.approvalId && c.cardToken) {
    const rogueSeed = crypto.getRandomValues(new Uint8Array(32));
    const rogue = {
      publicKey: ed25519.getPublicKey(rogueSeed),
      sign: async (m: Uint8Array) => ed25519.sign(m, rogueSeed),
    };
    const s = await signBody(c.cardToken, rogue);
    const res = await sign(c.approvalId, c.cardToken, s.body);
    const st = await json(
      await env.call(`/v1/approvals/${c.approvalId}/status`, {
        headers: { authorization: `Card ${c.cardToken}` },
      }),
    );
    record({
      name: 'Wrong key is refused and the card expires',
      ok: res.status === 422 && st.status === 'expired',
      detail: `HTTP ${res.status}, approval ${String(st.status)}`,
    });
  } else {
    record({
      name: 'Wrong key is refused and the card expires',
      ok: false,
      detail: 'no approval to test',
    });
  }
}

await env.done();

const allOk = checks.every((c) => c.ok);
const when = new Date().toISOString();
const md = `# PROOF

Run: \`bun run prove\` (scripts/prove.ts) · ${when}

Mode: **${remote ? `remote, NEAR testnet, ${env.base}` : 'local (in-process engine, fake chain, dry run: no transactions)'}**

| Check | Result | Detail | Link |
|---|---|---|---|
${checks.map((c) => `| ${c.name} | ${c.ok ? 'pass' : 'FAIL'} | ${c.detail.replaceAll('|', '/')} | ${c.link ? `[tx](${c.link})` : '—'} |`).join('\n')}

Overall: **${allOk ? 'all green' : 'NOT green'}**
${
  remote
    ? ''
    : `
Local mode proves the server checks (challenge, approval hash, device signature, reuse,
Guard before the card) but sends nothing on chain. The testnet proof needs a deployed
engine: see "Run the testnet proof" in README.md.
`
}`;
writeFileSync(join(import.meta.dir, '..', 'PROOF.md'), md);
console.log(`\nwrote PROOF.md (${allOk ? 'all green' : 'NOT green'})`);
process.exit(allOk ? 0 : 1);
