/**
 * Live NEAR AI Cloud TEE attestation check (docs/TEE.md).
 * Fetches a fresh report with a fresh nonce and runs the full verification:
 * Intel TDX quotes (dcap-qvl), nonce + signer binding, MRCONFIGID, RTMR3,
 * model id, NVIDIA GPU evidence via NRAS (JWT checked against NRAS JWKS).
 * The report endpoint is public; NEARAI_API_KEY is sent only if set.
 *
 * Run:    bun apps/engine/scripts/nearai-attestation-live.ts
 * Record: bun apps/engine/scripts/nearai-attestation-live.ts --record
 *         (writes the real report + collateral + NRAS replies to test/fixtures/nearai-attestation)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCollateral, PHALA_PCCS_URL, verify } from '@phala/dcap-qvl';
import {
  AttestationService,
  newNonce,
  type QuoteVerifier,
  sha256Hex,
  verifiedTdFrom,
} from '../src/brain/attestation.ts';

const record = process.argv.includes('--record');
const model = process.env.NEARAI_MODEL ?? 'z-ai/glm-5.3-flash';
const baseURL = process.env.NEARAI_BASE_URL ?? 'https://cloud-api.near.ai/v1';
const nonce = newNonce();
const now = new Date();

const collateral: Record<string, unknown> = {};
const quoteVerifier: QuoteVerifier = async (quote) => {
  const c = await getCollateral(PHALA_PCCS_URL, Buffer.from(quote));
  collateral[sha256Hex(quote)] = c;
  return verifiedTdFrom(verify(Buffer.from(quote), c, Math.floor(now.getTime() / 1000)));
};

let reportRaw: Uint8Array | null = null;
const nras: string[] = [];
let jwks: string | null = null;
const recordingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const res = await fetch(input, init);
  const url = String(input instanceof Request ? input.url : input);
  const raw = new Uint8Array(await res.clone().arrayBuffer());
  if (url.includes('/attestation/report')) reportRaw = raw;
  else if (url.includes('/attest/gpu')) nras.push(Buffer.from(raw).toString('utf8'));
  else if (url.includes('jwks')) jwks = Buffer.from(raw).toString('utf8');
  return res;
}) as typeof fetch;

const svc = new AttestationService({
  mode: 'enforce',
  baseURL,
  ...(process.env.NEARAI_API_KEY ? { apiKey: process.env.NEARAI_API_KEY } : {}),
  model,
  fetch: recordingFetch,
  quoteVerifier,
  nonce: () => nonce,
  now: () => now,
});
const status = await svc.check();
console.log(
  JSON.stringify(
    {
      verified: status.verified,
      model: status.model,
      reportHash: status.reportHash,
      tcbStatus: status.tcbStatus,
      gateway: status.gateway,
      modelSigners: status.modelSigners,
      gpus: status.gpus,
      error: status.error,
      checkedAt: status.checkedAt,
    },
    null,
    2,
  ),
);

if (record) {
  if (!reportRaw || !jwks) {
    console.error('nothing to record (report or JWKS missing)');
    process.exit(1);
  }
  const dir = join(import.meta.dir, '..', 'test', 'fixtures', 'nearai-attestation');
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, 'report.json'), reportRaw);
  await Bun.write(
    join(dir, 'meta.json'),
    JSON.stringify(
      {
        recordedAtUnix: Math.floor(now.getTime() / 1000),
        model,
        nonce,
        reportSha256: sha256Hex(reportRaw),
        verified: status.verified,
        source: `${baseURL}/attestation/report?model=${model}&provider=near&signing_algo=ecdsa&nonce=<nonce>`,
      },
      null,
      2,
    ),
  );
  await Bun.write(join(dir, 'collateral.json'), JSON.stringify(collateral));
  await Bun.write(join(dir, 'nras.json'), JSON.stringify(nras));
  await Bun.write(join(dir, 'nras-jwks.json'), jwks);
  console.log(`recorded fixtures in ${dir}`);
}
process.exit(status.verified ? 0 : 1);
