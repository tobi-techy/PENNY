import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repo = join(import.meta.dir, '../../..');
const out = join(repo, 'apps/engine/public-static');

type Config = {
  agents: { slug: string; cardSha256: string; cardUrl: string }[];
};

async function config(): Promise<Config> {
  return JSON.parse(await readFile(join(repo, 'config/concordium-agents.json'), 'utf8')) as Config;
}

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** The bytes a static host would send for the pinned card. */
async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

describe('static export for a static host', () => {
  test('exports every card byte-identical to its pinned hash', async () => {
    const { stdout } = await run('bun', [join(repo, 'scripts/concordium/export-static.mjs')], {
      cwd: repo,
    });
    expect(stdout).toContain('exported');

    for (const agent of (await config()).agents) {
      const digest = await sha256File(join(out, 'agents', agent.slug, 'agent-card.json'));
      // This is the exact value the registry compares against metadata_hash.
      expect(digest).toBe(agent.cardSha256);
    }
  });

  test('the well-known card is Penny, byte for byte', async () => {
    await run('bun', [join(repo, 'scripts/concordium/export-static.mjs')], { cwd: repo });
    const wellKnown = await readFile(join(out, '.well-known/agent-card.json'));
    const penny = await readFile(join(out, 'agents/penny/agent-card.json'));
    expect(wellKnown.equals(penny)).toBe(true);
  });

  test('writes the pages and a machine-readable crew index', async () => {
    await run('bun', [join(repo, 'scripts/concordium/export-static.mjs')], { cwd: repo });
    const index = JSON.parse(await readFile(join(out, 'agents/index.json'), 'utf8')) as {
      agents: { slug: string }[];
    };
    expect(index.agents.map((a) => a.slug)).toEqual(['penny', 'guard', 'invest', 'mail']);

    for (const slug of ['penny', 'guard', 'invest', 'mail']) {
      const html = await readFile(join(out, 'agents', slug, 'index.html'), 'utf8');
      expect(html).toContain('Verified by Concordium');
      // Static pages link the stylesheet by absolute path; no inline style.
      expect(html).toContain('/agents/passport.css');
      expect(html).not.toContain('<style');
    }
    expect(await readFile(join(out, 'agents/passport.css'), 'utf8')).toContain('box-sizing');
  });

  test('the host config sends JSON with the right content type and CORS', async () => {
    await run('bun', [join(repo, 'scripts/concordium/export-static.mjs')], { cwd: repo });
    const cfg = JSON.parse(await readFile(join(out, 'vercel.json'), 'utf8')) as {
      headers: { source: string; headers: { key: string; value: string }[] }[];
    };
    const card = cfg.headers.find((h) => h.source.includes('agent-card.json'));
    expect(card).toBeDefined();
    const keys = Object.fromEntries(card?.headers.map((h) => [h.key, h.value]) ?? []);
    expect(keys['content-type']).toContain('application/json');
    // A verifier on another origin must be able to read it.
    expect(keys['access-control-allow-origin']).toBe('*');
  });

  test('refuses to write a card whose bytes drifted from the pin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'penny-export-'));
    tmpDirs.push(dir);
    // The real config, but a card directory with one tampered card. --agents-dir
    // is what a host rebuild uses; here it isolates the failure to the bad pin.
    const agentsDir = join(dir, 'agents');
    await cp(join(repo, 'agents'), agentsDir, { recursive: true });
    await writeFile(join(agentsDir, 'penny/agent-card.json'), '{"name":"Penny","tampered":true}');

    type Failed = { code?: number; stdout?: string; stderr?: string };
    const result = (await run(
      'bun',
      [
        join(repo, 'scripts/concordium/export-static.mjs'),
        '--agents-dir',
        agentsDir,
        '--out',
        join(dir, 'dist'),
      ],
      { cwd: repo },
    ).catch((e: Failed) => e)) as Failed;

    // Non-zero exit and an explicit reason, never a silent bad pin.
    expect(result.code).toBe(1);
    expect(result.stderr ?? '').toContain('!= pinned');
  });
});
