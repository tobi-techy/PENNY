#!/usr/bin/env node

// Export the public passport pages and the pinned Agent Cards as static files,
// so any static host (Vercel, Cloudflare Pages, GitHub Pages, an S3 bucket) can
// serve them without the engine.
//
// Why a static export at all: the card URL is hashed and pinned on chain, so the
// host has to outlive a laptop and a tunnel. The engine itself cannot be
// serverless (it holds PGlite on local disk), but these files are pure reads.
//
// Usage:
//   bun run concordium:export                 # writes apps/engine/public-static
//   bun run concordium:export --out dist
//   bun run concordium:export --config other/agents.json
//
// Refuses to write a card whose bytes do not match the pinned SHA-256.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const OUT = resolve(
  repo,
  outFlag >= 0 ? (args[outFlag + 1] ?? 'dist') : 'apps/engine/public-static',
);
const cfgFlag = args.indexOf('--config');
const CONFIG = resolve(
  repo,
  cfgFlag >= 0
    ? (args[cfgFlag + 1] ?? 'config/concordium-agents.json')
    : 'config/concordium-agents.json',
);
const dirFlag = args.indexOf('--agents-dir');
const AGENTS_DIR = resolve(repo, dirFlag >= 0 ? (args[dirFlag + 1] ?? 'agents') : 'agents');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!existsSync(CONFIG)) fail(`missing ${CONFIG}`);
const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
if (!Array.isArray(config.agents) || config.agents.length === 0) fail('no agents in the config');

rmSync(OUT, { recursive: true, force: true });
const write = (rel, body) => {
  const path = join(OUT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return body;
};

// Imported lazily so the failure is a clear message: the renderers are
// TypeScript, which only Bun can import directly.
if (typeof Bun === 'undefined') {
  fail(
    'this script needs Bun (the passport renderers are TypeScript): run `bun run concordium:export`',
  );
}
const { pageHtml, indexHtml, indexSummary, PASSPORT_CSS } = await import(
  join(repo, 'apps/engine/src/passport/routes.ts')
);

const written = [];
const skipped = [];

// The cards first: they are the bytes pinned on chain, so they must be verbatim.
for (const agent of config.agents) {
  const path = join(AGENTS_DIR, agent.slug, 'agent-card.json');
  if (!existsSync(path)) {
    skipped.push(`${agent.slug}: no card file`);
    continue;
  }
  const raw = readFileSync(path, 'utf8');
  const digest = sha256(raw);
  if (digest !== agent.cardSha256) {
    // Writing changed bytes would fail the registry's hash check, so refuse.
    skipped.push(
      `${agent.slug}: card hash ${digest.slice(0, 12)} != pinned ${agent.cardSha256.slice(0, 12)}`,
    );
    continue;
  }
  // Both paths: the canonical one referenced on chain, and the passport twin.
  write(join('agents', agent.slug, 'agent-card.json'), raw);
  write(join('agents', agent.slug, 'card.json'), raw);
  written.push(`agents/${agent.slug}/agent-card.json`);
}

// Penny is also reachable at the A2A well-known path.
if (config.agents.some((a) => a.slug === 'penny')) {
  write(
    join('.well-known', 'agent-card.json'),
    readFileSync(join(AGENTS_DIR, 'penny', 'agent-card.json'), 'utf8'),
  );
  written.push('.well-known/agent-card.json');
}

write(join('agents', 'index.json'), `${JSON.stringify(indexSummary(config), null, 2)}\n`);
write(join('agents', 'index.html'), indexHtml(config));
write(join('agents', 'passport.css'), PASSPORT_CSS);
written.push('agents/index.json', 'agents/index.html', 'agents/passport.css');

for (const agent of config.agents) {
  write(join('agents', agent.slug, 'index.html'), pageHtml(agent, config));
  written.push(`agents/${agent.slug}/index.html`);
}

// A host may look for index.html at the root; point it at the crew.
write('index.html', indexHtml(config));
written.push('index.html');

// Tell the host these are static assets, not a SPA rewrite.
write(
  join('vercel.json'),
  `${JSON.stringify(
    {
      $schema: 'https://openapi.vercel.sh/vercel.json',
      cleanUrls: false,
      headers: [
        {
          source: '/agents/(.*)/agent-card.json',
          headers: [
            { key: 'content-type', value: 'application/json; charset=utf-8' },
            { key: 'cache-control', value: 'public, max-age=300' },
            { key: 'access-control-allow-origin', value: '*' },
          ],
        },
        {
          source: '/.well-known/agent-card.json',
          headers: [
            { key: 'content-type', value: 'application/json; charset=utf-8' },
            { key: 'cache-control', value: 'public, max-age=300' },
            { key: 'access-control-allow-origin', value: '*' },
          ],
        },
      ],
    },
    null,
    2,
  )}\n`,
);
written.push('vercel.json');

console.log(`exported ${written.length} files to ${OUT}`);
for (const w of written) console.log(`  ${w}`);
if (skipped.length > 0) {
  console.error('\nskipped:');
  for (const s of skipped) console.error(`  ${s}`);
  process.exitCode = 1;
}
