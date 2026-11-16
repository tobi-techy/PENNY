import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { passportRoutes, resetPassportCache } from '../src/passport/routes.ts';

const repo = join(import.meta.dir, '../../..');
const configPath = join(repo, 'config/concordium-agents.json');
const agentsDir = join(repo, 'agents');
const silent = { warn: () => {} };

function routes() {
  return passportRoutes({ configPath, agentsDir, log: silent });
}

const SLUGS = ['penny', 'guard', 'invest', 'mail'];

describe('passport pages', () => {
  test('index lists the whole crew as JSON for a machine', async () => {
    const res = routes().index('application/json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: { slug: string; badge: string }[] };
    expect(body.agents.map((a) => a.slug)).toEqual(SLUGS);
    expect(body.agents[0]?.badge).toBe('JyP9Wd81dn3JwiAs6agks');
  });

  test('serves the pinned card bytes verbatim for every agent', async () => {
    const rs = routes();
    const index = (await rs.index('application/json').json()) as {
      agents: { slug: string; cardSha256: string }[];
    };
    for (const agent of index.agents) {
      const res = rs.cardJson(agent.slug);
      expect(res.status).toBe(200);
      const raw = await res.text();
      const digest = new Bun.CryptoHasher('sha256').update(raw).digest('hex');
      // The registry compares this hash to the value pinned on chain.
      expect(digest).toBe(agent.cardSha256);
      expect(JSON.parse(raw).name).toBe(agent.slug[0]?.toUpperCase() + agent.slug.slice(1));
    }
  });

  test('the well-known card is Penny, byte for byte', () => {
    const wellKnown = routes().wellKnown();
    expect(wellKnown.status).toBe(200);
    const penny = routes().cardJson('penny');
    return Promise.all([wellKnown.text(), penny.text()]).then(([a, b]) => expect(a).toBe(b));
  });

  test('an unknown slug is a 404, not an empty page', async () => {
    expect(routes().page('nobody').status).toBe(404);
    expect(routes().cardJson('nobody').status).toBe(404);
    expect((await routes().image('nobody')).status).toBe(404);
  });

  test('the passport page names the badge, owner, and what the badge does not prove', async () => {
    const res = routes().page('guard');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('JyP9WeDVZoYEmqQfdWWtd');
    expect(html).toContain('3ewJGpdgo6NcDt36tmhnakMv9YB1qBQNPQBAinEJy9T1dpujfT');
    expect(html).toContain('1170');
    expect(html).toContain('does not prove the agent is safe');
    // No inline style or script: the passport CSP allows neither.
    expect(html).not.toContain('<style');
    expect(html).not.toContain('<script');
  });

  test('one stylesheet, loaded by link, is the only styling', async () => {
    const html = await routes().page('guard').text();
    expect(html).toContain('<link rel="stylesheet" href="/agents/passport.css" />');
  });

  test('the CIS-8 binding shows on the agent that carries it, and only there', async () => {
    // Penny has a bound NEAR key; the others do not, so the row must not leak.
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const penny = config.agents.find((a: { slug: string }) => a.slug === 'penny');
    expect(penny.externalReference?.nearAccount).toBe('penny-tobi.testnet');

    const pennyHtml = await routes().page('penny').text();
    expect(pennyHtml).toContain('Also answers to');
    expect(pennyHtml).toContain('penny-tobi.testnet');
    expect(pennyHtml).toContain('near:testnet');
    expect(pennyHtml).toContain('Key binding');

    const guardHtml = await routes().page('guard').text();
    expect(guardHtml).not.toContain('Key binding');
    expect(guardHtml).not.toContain('near:testnet');
  });

  test('the machine-readable crew summary carries the external reference', async () => {
    type Summary = {
      agents: {
        slug: string;
        externalReference?: { namespace: string; keyType: string; account?: string };
      }[];
    };
    const body = (await routes().index('application/json').json()) as Summary;
    const penny = body.agents.find((a) => a.slug === 'penny');
    expect(penny?.externalReference).toMatchObject({
      namespace: 'near:testnet',
      keyType: 'ed25519',
      account: 'penny-tobi.testnet',
    });
    const guard = body.agents.find((a) => a.slug === 'guard');
    expect(guard?.externalReference).toBeUndefined();
  });

  test('refuses to serve a card whose bytes no longer match the pin', async () => {
    resetPassportCache();
    const dir = await mkdtemp(join(tmpdir(), 'penny-passport-'));
    const warnings: string[] = [];
    // Guard with deliberately tampered card bytes.
    await mkdir(join(dir, 'guard'), { recursive: true });
    await writeFile(join(dir, 'guard/agent-card.json'), '{"name":"Guard","tampered":true}');
    const rs = passportRoutes({
      configPath,
      agentsDir: dir,
      log: { warn: (_o, m) => warnings.push(m ?? '') },
    });
    // The agent is registered, but its bytes fail the pin, so nothing is served.
    expect(rs.cardJson('guard').status).toBe(503);
    expect(rs.page('guard').status).toBe(200);
    expect(warnings.some((w) => w.includes('does not match the pinned hash'))).toBe(true);
    resetPassportCache();
    await rm(dir, { recursive: true, force: true });
  });

  test('renders a real PNG mark for each agent', async () => {
    const png = await routes()
      .image('invest')
      .then((r) => r.arrayBuffer());
    const bytes = new Uint8Array(png);
    expect(bytes.length).toBeGreaterThan(1000);
    // PNG magic, so this is an image whatever the browser does with it.
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test('serves one same-origin stylesheet', () => {
    const res = routes().css();
    expect(res.headers.get('content-type')).toContain('text/css');
  });

  test('mounted in the real engine: routes answer and keep the passport CSP', async () => {
    const { makeEngine } = await import('./helpers.ts');
    const t = await makeEngine({ extra: { concordiumConfigPath: configPath, agentsDir } });
    try {
      const index = await t.engine.app.request('/agents', {
        headers: { accept: 'application/json' },
      });
      expect(index.status).toBe(200);
      const card = await t.engine.app.request('/agents/penny/agent-card.json');
      expect(card.status).toBe(200);
      const raw = await card.text();
      const digest = new Bun.CryptoHasher('sha256').update(raw).digest('hex');
      // The pin comes from the config, not a literal, so a host change does not
      // break this test: the route must serve bytes that hash to the pin.
      const pinned = JSON.parse(readFileSync(configPath, 'utf8')) as {
        agents: { slug: string; cardSha256: string }[];
      };
      const pennyPin = pinned.agents.find((a) => a.slug === 'penny')?.cardSha256;
      if (!pennyPin) throw new Error('penny missing from concordium config');
      expect(digest).toBe(pennyPin);

      const page = await t.engine.app.request('/agents/penny');
      expect(page.status).toBe(200);
      // The strict API policy would block the stylesheet; the passport one allows it.
      const csp = page.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("style-src 'self'");
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain('unsafe-inline');

      const wellKnown = await t.engine.app.request('/.well-known/agent-card.json');
      expect(wellKnown.status).toBe(200);
      expect(await wellKnown.text()).toBe(raw);
    } finally {
      await t.db.close();
    }
  });
});
