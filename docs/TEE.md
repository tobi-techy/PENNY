# NEAR AI Cloud TEE attestation

Penny's brain runs on NEAR AI Cloud (`https://cloud-api.near.ai/v1`). NEAR AI serves models inside
Intel TDX confidential VMs with NVIDIA confidential-computing GPUs and publishes evidence for it.
This doc is what that evidence is, how Penny checks it, and what it does and does not prove.
Everything here was read from primary sources on 6 Nov 2026.

Code: `apps/engine/src/brain/attestation.ts`. Tests: `apps/engine/test/attestation.test.ts`
(real recorded report in `apps/engine/test/fixtures/nearai-attestation/`). Live check:
`bun apps/engine/scripts/nearai-attestation-live.ts`.

## Sources

- Verification overview: https://docs.near.ai/cloud/verification
- Gateway attestation: https://docs.near.ai/cloud/verification/cloud-api/gateway-attestation
- NEAR model attestations: https://docs.near.ai/cloud/verification/cloud-api/model-attestations
- Quote, nonce and signer bindings (report_data layout, MRCONFIGID, RTMR3 replay, NRAS):
  https://docs.near.ai/cloud/verification/reference/quote-nonce-signer
- Response signatures: https://docs.near.ai/cloud/verification/cloud-api/response-signatures
- Browser verifier: https://cloud.near.ai/verify
- NEAR's reference verifiers: https://github.com/nearai/nearai-cloud-verifier (`ts/chat_verifier.ts`,
  `ts/model_verifier.ts`), https://github.com/near-examples/nearai-cloud-verification-example
- Gateway source: https://github.com/nearai/cloud-api
- Intel DCAP quote verification (pure JS, Intel root CA): https://github.com/Phala-Network/dcap-qvl
  (`@phala/dcap-qvl` on npm)
- NVIDIA Remote Attestation Service: `POST https://nras.attestation.nvidia.com/v3/attest/gpu`,
  JWKS `https://nras.attestation.nvidia.com/.well-known/jwks.json`

## What the API gives you

`GET /v1/attestation/report?model=<id>&provider=near&signing_algo=ecdsa&nonce=<64 hex>` with
header `x-no-aliasing: true`. Public today (no key needed; Penny sends `NEARAI_API_KEY` if set).
Response:

| Field | What it is |
|---|---|
| `gateway_attestation` | The gateway's own dstack CVM: `intel_quote` (TDX), `event_log`, `request_nonce`, `report_data`, `signing_address` + `signing_algo`, `info.tcb_info.app_compose` |
| `model_attestations[]` | One report per NEAR-operated model signing identity: same TDX fields plus `model_name`, `signing_public_key` (E2EE) and `nvidia_payload` (GPU evidence: nonce + per-GPU evidence, 8 Hopper GPUs for `z-ai/glm-5.3-flash`) |
| `ohttp_*` | Oblivious HTTP key config (not used by Penny) |

Binding rules (NEAR-operated reports): the quote's 64-byte `report_data` is
`signer identity (20-byte ECDSA address, zero padded to 32) || our 32-byte nonce`. MRCONFIGID is
`01 || sha256(app_compose) || 15 zero bytes`. RTMR3 is the SHA-384 replay of `imr == 3` events.
GPU evidence carries the same nonce and is checked by NVIDIA NRAS.

Per response: `GET /v1/signature/{chat_id}?model=<id>&signing_algo=ecdsa` (needs an API key)
returns `{text, signature, signing_address, signing_algo, signature_kind}`. For
`signature_kind: provider_tee` the text is `<model>:<sha256(request bytes)>:<sha256(response bytes)>`
signed (EIP-191) by the model's attested key. For `gateway` it is `<req hash>:<resp hash>` signed
by the gateway's attested key (the gateway re-signs when it changes bytes: streaming, aliases).

## What Penny verifies

Preflight (`AttestationService.check`, fresh `crypto.randomBytes(32)` nonce every time):

1. Gateway report and every model candidate: TDX quote verified with dcap-qvl against Intel's
   root CA (collateral from Phala's PCCS; only the quote's FMSPC is sent), TCB status in
   `UpToDate | SWHardeningNeeded`, TD not in debug mode.
2. Quote `report_data` == signer || our nonce, echoed `request_nonce` == our nonce.
3. MRCONFIGID matches `app_compose`; RTMR3 matches the replayed event log.
4. Every candidate's `model_name` == `NEARAI_MODEL`; at least one candidate required.
5. GPU evidence: payload nonce == our nonce, NRAS verdict `x-nvidia-overall-att-result: true`,
   `eat_nonce` == our nonce, and the NRAS JWT's ES384 signature checked against NRAS JWKS.
6. A pass is cached per model for `NEARAI_ATTESTATION_TTL_SEC` (default 300 s); a fail for 30 s.

Per response, money and mail turns only: the provider fetch is wrapped to hash the exact request
and response bytes of each `/chat/completions` call in the turn (hashes only, nothing stored).
Before a money/mail tool runs, Penny fetches `/v1/signature/{chat_id}` for the completion that
asked for it, recovers the EIP-191 signer, requires the text to bind our model id and byte hashes,
and requires the signer to equal exactly one attested model key (or the attested gateway key for
`gateway` signatures). Completion requests carry `x-no-aliasing: true` when attestation is on.

What goes out: the nonce and model id to NEAR, NVIDIA's own GPU evidence to NRAS, the quote FMSPC
to the PCCS. No user text, keys or Penny secrets go to any verifier.

## Modes (`NEARAI_ATTESTATION`)

| Mode | Behaviour |
|---|---|
| `off` (default) | Nothing changes: no network calls, no headers, no fetch wrapper. `GET /v1/attestation` says `off`. |
| `warn` | Checks run; failures are logged and the crew reply is tagged `privacy.verified=false`. Tools still run. |
| `enforce` | A money or mail tool (any `propose_*`, `propose_write`, `find_bills`, any connected-app tool) refuses to run unless the preflight is verified and the completion is signed by an attested key. The reply becomes "private mode is unavailable right now...". Chat with no money or mail is unaffected. |

Status for UI and demo: `GET /v1/attestation` returns `{mode, model, verified, checkedAt,
reportHash (16 hex), tcbStatus, gateway, modelSigners, gpus, error, label, links}`; `label` is
`private · verified in TEE` when verified. When attestation is on, `GET /v1/approvals/:id` also
carries `privateInference: {verified, label}` from the cached status (no network call on the card
path), and `Crew.handle` returns `privacy: {verified, label, blocked}`.

## What this does not prove (from NEAR's own docs)

- Instances of one model share a signing key, so a matching signer does not prove the report and
  the completion came from the same serving instance.
- A `provider_tee` signature does not bind the model bytes to the gateway or TLS evidence, and a
  `gateway` signature proves only that the attested gateway signed the final bytes. There is no
  complete model to gateway to client chain yet.
- Penny does not pin measurements (MRTD, RTMR0-2, compose hash) to an allowlist: it checks they are
  internally consistent and Intel/NVIDIA-signed. Pinning is a policy step for later.
- TLS binding (`include_tls_fingerprint=true`) and the E2EE/OHTTP flows are not used.

## Live result

`bun apps/engine/scripts/nearai-attestation-live.ts --record`, 6 Nov 2026 13:11 UTC, no API key:

| | |
|---|---|
| verified | **true** |
| model | `z-ai/glm-5.3-flash` |
| report sha256 | `61da97842ff1d8176145fcab2980bbf737418768b6d4671ce7d81e8e2da572b3` (status `reportHash` `61da97842ff1d817`) |
| TCB | `UpToDate` (gateway and model) |
| gateway signer | `0xb98a789cdc4817275f5155593ba73ef2a957e779` (ecdsa) |
| model signer | `0x3b753b4406613c5e70ae640508632b600424fa0c` (ecdsa) |
| GPUs | 8 (NRAS overall result true) |

The engine itself was also booted with `NEARAI_ATTESTATION=warn` and `GET /v1/attestation`
returned `verified: true`, `label: "private · verified in TEE"`, 8 GPUs, `UpToDate`.

Per-response signature, 6 Nov 2026 13:45 UTC, with an API key
(`bun apps/engine/scripts/nearai-attestation-live.ts --signature`): a fresh report verified
(`reportHash` `ae5f8960fb7b6981`), one `glm-5.3-flash` completion (chat id
`637c7ca1a26544628ef6a08fd452891a`), its `/v1/signature` came back `provider_tee`, signed by
`0x3b753b4406613c5e70ae640508632b600424fa0c`, and `checkResponseSignature` verified it against the
attested model signer and the exact request and response bytes.

Default for the demo: `.env.example` ships `NEARAI_ATTESTATION=enforce`, so money and mail turns
run only when the report and the reply signature verify. Set `NEARAI_API_KEY`, or every money and
mail turn is refused (`signature_needs_api_key`). The code default stays `off`, so tests and bare
boots without an env file are unchanged.
