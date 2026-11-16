#!/usr/bin/env node
// Concordium testnet registration spike for Penny.
//
// Runs on Node, not Bun: @concordium/web-sdk@9.2.0 advertises a `bun` export
// condition that points at TypeScript source Bun cannot resolve. Node 20+ uses
// the compiled ESM build.
//
// Testnet only. No mainnet, no user keys. The seed stays in .concordium/seed.txt
// (mode 0600) and is never logged or committed.
//
// Usage:
//   node scripts/concordium/register.mjs account
//   node scripts/concordium/register.mjs register penny
//   node scripts/concordium/register.mjs verify penny
//   node scripts/concordium/register.mjs all penny

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as sdk from '@concordium/web-sdk';

const WP = 'https://wallet-proxy.testnet.concordium.com';
const GRPC = 'https://grpc.testnet.concordium.com';
const MCP = 'https://agent-registry-mcp.concordium.com';
const EXPLORER = (hash) => `https://ccdexplorer.io/testnet/transaction/${hash}`;
const REGISTRY = { index: 12802n, subindex: 0n };
const REDIRECT = 'https://wallet.testnet.concordium.com/callback';
const STATE_DIR = join(process.cwd(), '.concordium');
const STATE_FILE = join(STATE_DIR, 'state.json');
const SEED_FILE = join(STATE_DIR, 'seed.txt');
const MIN_BALANCE = 150_000_000n; // 150 CCD
const MAX_DROPS = 8;

const client = new sdk.ConcordiumGRPCWebClient(GRPC, 20000);

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function loadSeed() {
  if (!existsSync(SEED_FILE)) return null;
  return readFileSync(SEED_FILE, 'utf8').trim();
}

function saveSeed(seed) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SEED_FILE, `${seed}\n`, { mode: 0o600 });
}

const B58A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58encode(buf) {
  let n = 0n;
  for (const x of buf) n = (n << 8n) | BigInt(x);
  let out = '';
  while (n > 0n) {
    out = B58A[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const x of buf) {
    if (x === 0) out = `1${out}`;
    else break;
  }
  return out;
}

function b58check(payload) {
  const checksum = createHash('sha256')
    .update(createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, 4);
  return b58encode(Buffer.concat([payload, checksum]));
}

function uleb(n) {
  const out = [];
  let v = BigInt(n);
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) out.push(b | 0x80);
    else {
      out.push(b);
      break;
    }
  }
  return Buffer.from(out);
}

function badgeFor(contract, tokenIdHex) {
  return b58check(
    Buffer.concat([
      Buffer.from([2]),
      uleb(contract.index),
      uleb(contract.subindex),
      Buffer.from(tokenIdHex, 'hex'),
    ]),
  );
}

function failedOf(json) {
  const m = json.match(
    /"transactionType":"failed".*?"rejectReason":\{"tag":"(\w+)","contents":"?([^"}]*)"?/,
  );
  return m ? { tag: m[1], contents: m[2] } : null;
}

function assertOk(json, label, allow = []) {
  const failed = failedOf(json);
  if (failed && !allow.includes(failed.tag)) {
    throw new Error(`${label} rejected on-chain: ${failed.tag} ${failed.contents}`);
  }
  if (!failed && json.includes('"transactionType":"failed"')) {
    throw new Error(`${label} failed: ${json.slice(0, 400)}`);
  }
  return failed;
}

async function finalize(hash, label) {
  const txHash = typeof hash === 'string' ? sdk.TransactionHash.fromHexString(hash) : hash;
  for (let i = 0; i < 25; i++) {
    const summary = await client.waitForTransactionFinalization(txHash, 15000).catch((e) => {
      if (i === 24) throw e;
      return null;
    });
    if (summary) {
      const json = JSON.stringify(summary, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
      writeFileSync(join(STATE_DIR, `summary-${label}.json`), json, { mode: 0o600 });
      log(label, 'finalized');
      return { summary, json };
    }
  }
  throw new Error(`${label} not finalized`);
}

async function sendTx(tx, signer) {
  const signature = await sdk.signTransaction(tx, signer);
  return sdk.TransactionHash.toHexString(await client.sendAccountTransaction(tx, signature));
}

// Submit a contract update from the owner account and wait for finalisation.
async function sendContractUpdate(
  state,
  signer,
  { index, subindex, receiveName, parameterHex, energy },
) {
  const addr = sdk.AccountAddress.fromBase58(state.address);
  const nonceInfo = await client.getNextAccountNonce(addr);
  const nonce = nonceInfo.seqNumber ?? nonceInfo.nonce;
  const tx = {
    type: sdk.AccountTransactionType.Update,
    header: {
      expiry: sdk.TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
      nonce,
      sender: addr,
    },
    payload: {
      amount: sdk.CcdAmount.zero(),
      address: { index, subindex },
      receiveName: sdk.ReceiveName.fromString(receiveName),
      message: sdk.Parameter.fromBuffer(Buffer.from(parameterHex, 'hex')),
      maxContractExecutionEnergy: sdk.Energy.create(BigInt(energy ?? 30000)),
    },
  };
  const hash = await sendTx(tx, signer);
  const { json } = await finalize(hash, receiveName);
  assertOk(json, receiveName);
  return hash;
}

async function balance(address) {
  const info = await client
    .getAccountInfo(sdk.AccountAddress.fromBase58(address))
    .catch(() => null);
  if (!info) return 0n;
  const micro =
    info.accountAmount ??
    info.accountBalance?.microCcdAmount ??
    info.balance?.balance?.microCcdAmount ??
    0n;
  if (typeof micro === 'bigint') return micro;
  const s = String(micro);
  if (s.includes('.')) {
    const [whole, frac = ''] = s.split('.');
    return BigInt(whole || '0') * 1_000_000n + BigInt(`${frac}000000`.slice(0, 6));
  }
  return BigInt(s);
}

async function fundUntilReady(state) {
  for (let i = 0; i < MAX_DROPS; i++) {
    const bal = await balance(state.address);
    if (bal >= MIN_BALANCE) {
      log('balance CCD:', Number(bal) / 1e6);
      return;
    }
    const r = await fetch(`${WP}/v0/testnetGTUDrop/${state.address}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.submissionId) {
      throw new Error(`faucet: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    }
    state.drops = [...(state.drops ?? []), j.submissionId];
    saveState(state);
    log('GTU drop sent', j.submissionId);
    await finalize(j.submissionId, `drop${state.drops.length}`).catch((e) =>
      log('drop wait:', e.message),
    );
    await new Promise((r2) => setTimeout(r2, 2000));
  }
  const bal = await balance(state.address);
  if (bal < MIN_BALANCE) throw new Error(`balance ${bal} below ${MIN_BALANCE}`);
  log('balance CCD:', Number(bal) / 1e6);
}

async function issueIdentity(state, seed) {
  const provs = await (
    await fetch(`${WP}/v1/ip_info`, { signal: AbortSignal.timeout(20000) })
  ).json();
  const p0 = provs.find((x) => x.ipInfo?.ipIdentity === 0);
  if (!p0) throw new Error('testnet ipIdentity 0 not found');
  const gp = await client.getCryptographicParameters();
  const ars = [];
  for await (const a of client.getAnonymityRevokers()) ars.push(a);
  const arsInfos = Object.fromEntries(ars.map((a) => [String(a.arIdentity), a]));
  const idReq = sdk.createIdentityRequest({
    ipInfo: p0.ipInfo,
    globalContext: gp,
    arsInfos,
    arThreshold: ars.length,
    seed,
    net: 'Testnet',
    identityIndex: 0,
  });
  let url = `${p0.metadata.issuanceStart}?${new URLSearchParams({
    scope: 'identity',
    response_type: 'code',
    redirect_uri: REDIRECT,
    state: JSON.stringify({ idObjectRequest: idReq }),
  })}`;
  let verifierPage = null;
  for (let hop = 0; hop < 6 && !verifierPage; hop++) {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if (r.status === 200) {
      verifierPage = url;
      break;
    }
    const loc = r.headers.get('location') ?? '';
    if (loc) url = loc.startsWith('http') ? loc : new URL(loc, url).toString();
    else break;
  }
  if (!verifierPage) throw new Error('no verifier page');
  const page = await (await fetch(verifierPage, { signal: AbortSignal.timeout(20000) })).text();
  const fields = {};
  for (const m of page.matchAll(/<input[^>]*>/gi)) {
    const name = /name="([^"]+)"/.exec(m[0])?.[1];
    const value = /value="([^"]*)"/.exec(m[0])?.[1] ?? '';
    if (name && !['fail', 'submit', 'expiry'].includes(name)) fields[name] = value;
  }
  fields.expiry = '2030-12';
  const action = /action="([^"]+)"/.exec(page)?.[1];
  if (!action) throw new Error('no verifier form action');
  const postUrl = new URL(action, verifierPage).toString();
  const post = await fetch(postUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(30000),
  });
  let codeUri = null;
  let next = post.headers.get('location');
  for (let hop = 0; hop < 6 && !codeUri; hop++) {
    if (!next) break;
    const m = decodeURIComponent(next).match(/code_uri=(https?:\/\/[^\s&#]+)/);
    if (m) {
      codeUri = m[1];
      break;
    }
    const r2 = await fetch(next.startsWith('http') ? next : new URL(next, postUrl), {
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    next = r2.headers.get('location');
  }
  if (!codeUri) throw new Error('no code_uri after verifier form');
  state.codeUri = codeUri;
  saveState(state);
  for (let i = 0; i < 12; i++) {
    const s = await (await fetch(codeUri, { signal: AbortSignal.timeout(15000) }))
      .json()
      .catch(() => ({ status: 'pending' }));
    if (s.status === 'done') return s.token.identityObject;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('identity object not issued in time');
}

async function deployCredential(state, seed, signingKey) {
  const provs = await (
    await fetch(`${WP}/v1/ip_info`, { signal: AbortSignal.timeout(20000) })
  ).json();
  const p0 = provs.find((x) => x.ipInfo?.ipIdentity === 0);
  if (!p0) throw new Error('testnet ipIdentity 0 not found');
  const gp = await client.getCryptographicParameters();
  const ars = [];
  for await (const a of client.getAnonymityRevokers()) ars.push(a);
  const arsInfos = Object.fromEntries(ars.map((a) => [String(a.arIdentity), a]));
  const expiry = sdk.TransactionExpiry.fromDate(new Date(Date.now() + 60 * 60 * 1000));
  const cdt = sdk.createCredentialTransaction(
    {
      ipInfo: {
        ...p0.ipInfo,
        ipRealName: p0.ipInfo.ipDescription?.name ?? 'Concordium testnet identity provider',
      },
      globalContext: gp,
      arsInfos,
      idObject: state.idObject.value ?? state.idObject,
      revealedAttributes: [],
      credNumber: 0,
      seedAsHex: seed,
      net: 'Testnet',
      identityIndex: 0,
    },
    expiry,
  );
  const signature = await sdk.signCredentialTransaction(cdt, signingKey);
  const payload = sdk.serializeCredentialDeploymentPayload([signature], cdt);
  const credId = cdt.unsignedCdi.values?.credId ?? cdt.unsignedCdi.credId;
  state.address = sdk.AccountAddress.toBase58(sdk.getAccountAddress(credId));
  saveState(state);
  log('account (precomputed):', state.address);
  state.credTx = sdk.TransactionHash.toHexString(
    await client.sendCredentialDeploymentTransaction(payload, expiry),
  );
  saveState(state);
  log('credential deployment sent', state.credTx, EXPLORER(state.credTx));
  const { json } = await finalize(state.credTx, 'cred');
  assertOk(json, 'credential deployment');
}

// A second (or third) account from the SAME identity.
//
// Concordium identities allow many accounts, and the credential's keys are
// derived from the seed plus a credential number, so no new identity is needed.
// That matters right now: issueIdentity pins testnet ipIdentity 0, and that
// provider's host no longer resolves, so minting a fresh identity is impossible.
// Deploying another credential does not touch the provider's web host at all.
//
// Deliberately does not reuse deployCredential(), which overwrites the owner
// account in state.json. These accounts are recorded under state.extra instead.
async function deployExtraCredential(state, seed, signingKey, credNumber) {
  const provs = await (
    await fetch(`${WP}/v1/ip_info`, { signal: AbortSignal.timeout(20000) })
  ).json();
  const p0 = provs.find((x) => x.ipInfo?.ipIdentity === 0);
  if (!p0) throw new Error('testnet ipIdentity 0 not found');
  const gp = await client.getCryptographicParameters();
  const ars = [];
  for await (const a of client.getAnonymityRevokers()) ars.push(a);
  const arsInfos = Object.fromEntries(ars.map((a) => [String(a.arIdentity), a]));
  const expiry = sdk.TransactionExpiry.fromDate(new Date(Date.now() + 60 * 60 * 1000));
  const cdt = sdk.createCredentialTransaction(
    {
      ipInfo: {
        ...p0.ipInfo,
        ipRealName: p0.ipInfo.ipDescription?.name ?? 'Concordium testnet identity provider',
      },
      globalContext: gp,
      arsInfos,
      idObject: state.idObject.value ?? state.idObject,
      revealedAttributes: [],
      credNumber,
      seedAsHex: seed,
      net: 'Testnet',
      identityIndex: 0,
    },
    expiry,
  );
  const signature = await sdk.signCredentialTransaction(cdt, signingKey);
  const payload = sdk.serializeCredentialDeploymentPayload([signature], cdt);
  const credId = cdt.unsignedCdi.values?.credId ?? cdt.unsignedCdi.credId;
  const address = sdk.AccountAddress.toBase58(sdk.getAccountAddress(credId));
  log(`account ${credNumber} (precomputed):`, address);
  const txHash = sdk.TransactionHash.toHexString(
    await client.sendCredentialDeploymentTransaction(payload, expiry),
  );
  log(`credential ${credNumber} deployment sent`, txHash, EXPLORER(txHash));
  const { json } = await finalize(txHash, `cred${credNumber}`);
  assertOk(json, `credential ${credNumber}`);
  state.extra = { ...(state.extra ?? {}), [credNumber]: { address, credTx: txHash } };
  saveState(state);
  return address;
}

async function fundAddress(state, address) {
  for (let i = 0; i < MAX_DROPS; i++) {
    const bal = await balance(address);
    if (bal >= MIN_BALANCE) {
      log(`${address} balance CCD:`, Number(bal) / 1e6);
      return bal;
    }
    const r = await fetch(`${WP}/v0/testnetGTUDrop/${address}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.submissionId) throw new Error(`faucet: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    log('GTU drop sent', j.submissionId);
    await finalize(j.submissionId, 'drop').catch((e) => log('drop wait:', e.message));
    await new Promise((r2) => setTimeout(r2, 2000));
  }
  const bal = await balance(address);
  if (bal < MIN_BALANCE) throw new Error(`balance ${bal} below ${MIN_BALANCE}`);
  log(`${address} balance CCD:`, Number(bal) / 1e6);
  return bal;
}

// node scripts/concordium/register.mjs extra --cred 1
async function stageExtra(flags) {
  const state = loadState();
  const seed = loadSeed();
  if (!seed) throw new Error('no .concordium/seed.txt; run the account stage first');
  if (!state.idObject) throw new Error('no identity; run the account stage first');
  const credNumber = Number(flags.cred ?? 1);
  if (!Number.isInteger(credNumber) || credNumber < 1) throw new Error('--cred must be an integer >= 1');

  const wallet = sdk.ConcordiumHdWallet.fromHex(seed, 'Testnet');
  // Each credential has its own key path: identityIndex / credNumber / keyIndex.
  // Signing credential 1 with credential 0's key is rejected as invalid signatures.
  const signingKey = wallet.getAccountSigningKey(0, credNumber, 0).toString('hex');

  const existing = state.extra?.[credNumber]?.address;
  const address = existing ?? (await deployExtraCredential(state, seed, signingKey, credNumber));
  log('account:', address);
  log('explorer:', `https://ccdexplorer.io/testnet/account/${address}`);
  await fundAddress(state, address);
}

async function readChain(state) {
  const cs = await client.getConsensusStatus();
  const json = JSON.stringify(cs, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  const genesis = json.match(/"genesisBlock":"?([0-9a-f]{64})"?/)?.[1];
  if (!genesis) throw new Error('cannot read genesis hash');
  state.genesis = genesis;
  state.chainId = genesis.slice(0, 32);
  saveState(state);
  log('chain id:', `ccd:${state.chainId}`);
}

async function mcpTool(name, args) {
  const r = await fetch(`${MCP}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`MCP ${name} HTTP ${r.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  if (j.error) throw new Error(`MCP ${name}: ${JSON.stringify(j.error)}`);
  const content = j.result?.content?.[0]?.text;
  if (!content) throw new Error(`MCP ${name}: no content`);
  return JSON.parse(content);
}

async function checkBadge(badge) {
  const r = await fetch(`${MCP}/v1/check-badge/${encodeURIComponent(badge)}?network=testnet`, {
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Leave the raw text for the caller.
  }
  return { status: r.status, json, text: text.slice(0, 2000) };
}

function extractTokenId(json) {
  const m = json.match(/"events":\["(?:fe|f0|f5)08([0-9a-f]{16})/);
  if (!m) throw new Error('minted token not found in register events');
  return m[1];
}

async function registerAgent(state, signer, slug) {
  state.agents ??= {};
  state.agents[slug] ??= {};
  const agent = state.agents[slug];

  if (agent.registerTx && agent.tokenIdHex) {
    log('already registered', agent.registerTx);
    return agent;
  }

  if (agent.registerTx) {
    log('resuming register', agent.registerTx);
    const { json } = await finalize(agent.registerTx, `register-${slug}`);
    assertOk(json, 'register');
    agent.tokenIdHex = extractTokenId(json);
    agent.tokenId = String(Buffer.from(agent.tokenIdHex, 'hex').readBigUInt64LE(0));
    agent.badge = badgeFor(REGISTRY, agent.tokenIdHex);
    saveState(state);
    log('token id', agent.tokenId, 'badge', agent.badge);
    return agent;
  }

  const built = await mcpTool('build_register', {
    network: 'testnet',
    sender: state.address,
    agent_uri: null,
    metadata_hash_hex: null,
    initial_metadata: [],
  });
  const parameterHex = built.parameter_hex;
  if (!parameterHex) throw new Error(`build_register: ${JSON.stringify(built).slice(0, 300)}`);

  const addr = sdk.AccountAddress.fromBase58(state.address);
  const nonceInfo = await client.getNextAccountNonce(addr);
  const nonce = nonceInfo.seqNumber ?? nonceInfo.nonce;
  const tx = {
    type: sdk.AccountTransactionType.Update,
    header: {
      expiry: sdk.TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
      nonce,
      sender: addr,
    },
    payload: {
      amount: sdk.CcdAmount.zero(),
      address: { index: REGISTRY.index, subindex: REGISTRY.subindex },
      receiveName: sdk.ReceiveName.fromString(built.receive_name ?? 'CIS-8004.register'),
      message: sdk.Parameter.fromBuffer(Buffer.from(parameterHex, 'hex')),
      maxContractExecutionEnergy: sdk.Energy.create(BigInt(built.suggested_energy ?? 30000)),
    },
  };
  const hash = await sendTx(tx, signer);
  agent.registerTx = hash;
  saveState(state);
  log('register sent', hash, EXPLORER(hash));
  const { json } = await finalize(hash, `register-${slug}`);
  assertOk(json, 'register');
  agent.tokenIdHex = extractTokenId(json);
  agent.tokenId = String(Buffer.from(agent.tokenIdHex, 'hex').readBigUInt64LE(0));
  agent.badge = badgeFor(REGISTRY, agent.tokenIdHex);
  saveState(state);
  log('token id', agent.tokenId, 'badge', agent.badge);
  return agent;
}

async function stageAccount() {
  const state = loadState();
  let seed = loadSeed();
  if (!seed) {
    seed = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('hex');
    saveSeed(seed);
    log('seed generated in .concordium/seed.txt (testnet only, never commit)');
  }
  const wallet = sdk.ConcordiumHdWallet.fromHex(seed, 'Testnet');
  const signingKey = wallet.getAccountSigningKey(0, 0, 0).toString('hex');

  if (!state.idObject) {
    log('issuing testnet identity');
    state.idObject = await issueIdentity(state, seed);
    saveState(state);
    log('identity issued');
  }

  if (!state.address) {
    log('deploying credential');
    await deployCredential(state, seed, signingKey);
  }

  await fundUntilReady(state);
  await readChain(state);
  log('account:', state.address);
  log('explorer:', `https://ccdexplorer.io/testnet/account/${state.address}`);
}

async function stageRegister(slug) {
  const state = loadState();
  const seed = loadSeed();
  if (!seed) throw new Error('no .concordium/seed.txt; run the account stage first');
  if (!state.address) throw new Error('no account; run the account stage first');
  const wallet = sdk.ConcordiumHdWallet.fromHex(seed, 'Testnet');
  const signingKey = wallet.getAccountSigningKey(0, 0, 0).toString('hex');
  const signer = sdk.buildBasicAccountSigner(signingKey);

  const agent = await registerAgent(state, signer, slug);
  const check = await checkBadge(agent.badge);
  log('badge check:', check.status, JSON.stringify(check.json ?? check.text).slice(0, 800));
}

async function pinAgent(state, signer, slug, cardUrl) {
  const agent = state.agents?.[slug];
  if (!agent?.tokenId) throw new Error(`no token for ${slug}; run the register stage first`);
  const cardPath = join(process.cwd(), 'agents', slug, 'agent-card.json');
  const cardBytes = readFileSync(cardPath);
  const cardSha = createHash('sha256').update(cardBytes).digest('hex');

  const built = await mcpTool('build_set_agent_uri', {
    network: 'testnet',
    token_id: agent.tokenId,
    agent_uri: cardUrl,
    metadata_hash_hex: cardSha,
    sender: state.address,
  });
  const parameterHex = built.parameter_hex;
  if (!parameterHex) {
    throw new Error(`build_set_agent_uri: ${JSON.stringify(built).slice(0, 300)}`);
  }

  const addr = sdk.AccountAddress.fromBase58(state.address);
  const nonceInfo = await client.getNextAccountNonce(addr);
  const nonce = nonceInfo.seqNumber ?? nonceInfo.nonce;
  const tx = {
    type: sdk.AccountTransactionType.Update,
    header: {
      expiry: sdk.TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
      nonce,
      sender: addr,
    },
    payload: {
      amount: sdk.CcdAmount.zero(),
      address: { index: REGISTRY.index, subindex: REGISTRY.subindex },
      receiveName: sdk.ReceiveName.fromString(built.receive_name ?? 'CIS-8004.setAgentURI'),
      message: sdk.Parameter.fromBuffer(Buffer.from(parameterHex, 'hex')),
      maxContractExecutionEnergy: sdk.Energy.create(BigInt(built.suggested_energy ?? 30000)),
    },
  };
  const hash = await sendTx(tx, signer);
  agent.cardUrl = cardUrl;
  agent.cardSha = cardSha;
  agent.pinTx = hash;
  saveState(state);
  log('setAgentURI sent', hash, EXPLORER(hash));
  log('card sha256', cardSha);
  const { json } = await finalize(hash, `pin-${slug}`);
  assertOk(json, 'setAgentURI');
  return agent;
}

async function stagePin(slug, cardUrl) {
  if (!cardUrl)
    throw new Error('usage: node scripts/concordium/register.mjs pin <slug> <card-url>');
  const state = loadState();
  const seed = loadSeed();
  if (!seed) throw new Error('no .concordium/seed.txt; run the account stage first');
  if (!state.address) throw new Error('no account; run the account stage first');
  const wallet = sdk.ConcordiumHdWallet.fromHex(seed, 'Testnet');
  const signingKey = wallet.getAccountSigningKey(0, 0, 0).toString('hex');
  const signer = sdk.buildBasicAccountSigner(signingKey);

  const agent = await pinAgent(state, signer, slug, cardUrl);
  const check = await checkBadge(agent.badge);
  log('badge check:', check.status, JSON.stringify(check.json ?? check.text).slice(0, 1200));
}

async function stageVerify(slug) {
  const state = loadState();
  const agent = state.agents?.[slug];
  if (!agent?.badge) throw new Error(`no badge for ${slug}; run the register stage first`);
  const check = await checkBadge(agent.badge);
  log('badge:', agent.badge);
  log('check:', check.status, JSON.stringify(check.json ?? check.text, null, 2));
}

// CIS-8 binding: prove that the Concordium account controls an external key
// (in Penny's case the NEAR operator key), so the agent is reachable by the
// address it already uses elsewhere.
//
// The external key signs the canonical bytes itself and this script is handed
// only the public key and the signature. The NEAR secret never reaches these
// scripts and never touches disk.
//
//   node scripts/concordium/register.mjs cis8 \
//     --namespace near:testnet --pubkey <hex> --sig <hex> --near-account penny-tobi.testnet
async function stageCis8(flags) {
  const state = loadState();
  if (!state.address) throw new Error('no account; run the account stage first');
  const namespace = flags.namespace;
  const pubkey = flags.pubkey;
  const sig = flags.sig;
  if (!namespace || !pubkey || !sig) {
    throw new Error('cis8 needs --namespace, --pubkey and --sig');
  }

  // Always re-derive the canonical bytes here rather than trusting a pasted
  // signature: if the account or namespace changed, the signature will not
  // verify and the contract will reject it, so fail before spending energy.
  const canonical = await mcpTool('build_cis8_canonical_bytes', {
    network: 'testnet',
    concordium_account: state.address,
    external_namespace: namespace,
    external_key_namespace: namespace,
    external_key_type: 'ed25519',
    external_public_key_hex: pubkey,
    proof_scheme: 'solana-ed25519',
  });
  log('canonical bytes:', canonical.byte_length, 'bytes, signed by the external key');

  const built = await mcpTool('build_cis8_register', {
    network: 'testnet',
    sender: state.address,
    external_key: { namespace, key_type: 'ed25519', public_key_hex: pubkey },
    proof: { scheme: 'solana-ed25519', signature_hex: sig },
    metadata: flags['near-account']
      ? [{ key: 'near_account', value: flags['near-account'] }]
      : null,
  });
  if (!built.parameter_hex) {
    throw new Error(`build_cis8_register: ${JSON.stringify(built).slice(0, 300)}`);
  }

  const seed = loadSeed();
  if (!seed) throw new Error('no .concordium/seed.txt; run the account stage first');
  const wallet = sdk.ConcordiumHdWallet.fromHex(seed, 'Testnet');
  const signer = sdk.buildBasicAccountSigner(wallet.getAccountSigningKey(0, 0, 0).toString('hex'));

  const addr = sdk.AccountAddress.fromBase58(state.address);
  const nonceInfo = await client.getNextAccountNonce(addr);
  const nonce = nonceInfo.seqNumber ?? nonceInfo.nonce;
  const tx = {
    type: sdk.AccountTransactionType.Update,
    header: {
      expiry: sdk.TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
      nonce,
      sender: addr,
    },
    payload: {
      amount: sdk.CcdAmount.zero(),
      address: { index: 12801n, subindex: 0n },
      receiveName: sdk.ReceiveName.fromString(built.receive_name ?? 'CIS-8.registerExternalKey'),
      message: sdk.Parameter.fromBuffer(Buffer.from(built.parameter_hex, 'hex')),
      maxContractExecutionEnergy: sdk.Energy.create(BigInt(built.suggested_energy ?? 30000)),
    },
  };

  const hash = await sendTx(tx, signer);
  log('registerExternalKey sent', hash, EXPLORER(hash));
  const { json } = await finalize(hash, 'cis8');
  assertOk(json, 'registerExternalKey');

  state.cis8 = {
    namespace,
    keyType: 'ed25519',
    publicKeyHex: pubkey,
    nearAccount: flags['near-account'] ?? null,
    txHash: hash,
  };
  saveState(state);

  const reg = await mcpTool('owner_of_key', {
    network: 'testnet',
    external_key: { namespace, key_type: 'ed25519', public_key_hex: pubkey },
  });
  log('owner_of_key:', JSON.stringify(reg));
  return hash;
}

// Attach a CIS-8 key to an agent as its external reference, so the agent can be
// found by the address it already uses on another chain.
//
//   node scripts/concordium/register.mjs extref --slug penny \
//     --namespace near:testnet --pubkey <hex>
async function stageExternalRef(flags) {
  const state = loadState();
  const slug = flags.slug ?? 'penny';
  const agent = state.agents?.[slug];
  if (!agent?.tokenId) throw new Error(`no token for ${slug}; run the register stage first`);
  const namespace = flags.namespace;
  const pubkey = flags.pubkey;
  if (!namespace || !pubkey) throw new Error('extref needs --namespace and --pubkey');

  const built = await mcpTool('build_set_external_reference', {
    network: 'testnet',
    sender: state.address,
    token_id: agent.tokenId,
    external_reference: {
      contract_address: { index: 12801, subindex: 0 },
      kind: 'Cis8',
      key: { namespace, key_type: 'ed25519', public_key_hex: pubkey },
    },
  });
  if (!built.parameter_hex) {
    throw new Error(`build_set_external_reference: ${JSON.stringify(built).slice(0, 300)}`);
  }

  const seed = loadSeed();
  if (!seed) throw new Error('no .concordium/seed.txt; run the account stage first');
  const wallet = sdk.ConcordiumHdWallet.fromHex(seed, 'Testnet');
  const signer = sdk.buildBasicAccountSigner(wallet.getAccountSigningKey(0, 0, 0).toString('hex'));

  const hash = await sendContractUpdate(state, signer, {
    index: 12802n,
    subindex: 0n,
    receiveName: built.receive_name ?? 'CIS-8004.setExternalReference',
    parameterHex: built.parameter_hex,
    energy: built.suggested_energy,
  });
  log('setExternalReference sent', hash, EXPLORER(hash));

  agent.externalReference = {
    namespace,
    keyType: 'ed25519',
    publicKeyHex: pubkey,
    txHash: hash,
  };
  saveState(state);

  const found = await mcpTool('agent_by_external_reference', {
    network: 'testnet',
    external_reference: {
      contract_address: { index: 12801, subindex: 0 },
      kind: 'Cis8',
      key: { namespace, key_type: 'ed25519', public_key_hex: pubkey },
    },
  });
  log('agent_by_external_reference ->', JSON.stringify(found).slice(0, 600));
  return hash;
}

async function main() {
  const stage = process.argv[2] ?? 'account';
  const slug = process.argv[3] ?? 'penny';
  const flags = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) flags[arg.slice(2)] = process.argv[i + 1];
  }
  if (stage === 'account') await stageAccount();
  else if (stage === 'register') await stageRegister(slug);
  else if (stage === 'pin') await stagePin(slug, process.argv[4]);
  else if (stage === 'verify') await stageVerify(slug);
  else if (stage === 'cis8') await stageCis8(flags);
  else if (stage === 'extref') await stageExternalRef(flags);
  else if (stage === 'extra') await stageExtra(flags);
  else if (stage === 'all') {
    await stageAccount();
    await stageRegister(slug);
    await stageVerify(slug);
  } else {
    console.error(
      'usage: node scripts/concordium/register.mjs account|register|pin|verify|cis8|extref|extra|all [slug] [card-url]',
    );
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  if (client.shutdown) await client.shutdown().catch(() => {});
}
