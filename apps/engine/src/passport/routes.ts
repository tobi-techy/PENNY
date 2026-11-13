import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { esc } from '../cards/render.ts';
import { sha256Hex } from '../lib/crypto.ts';

/**
 * Public passport pages for the registered crew. The bytes served at
 * /agents/:slug/agent-card.json are the exact bytes pinned on chain, so the
 * registry's hash check passes. If the file on disk no longer hashes to the
 * pinned value the route refuses to serve it rather than serve a silent lie.
 */

export type RegisteredAgent = {
  slug: string;
  name: string;
  tokenId: string;
  badge: string;
  cardUrl: string;
  cardSha256: string;
  registerTx: string;
  pinTx: string;
  explorer: { account: string; register: string; pin: string; verify: string };
};

export type RegistryConfig = {
  network: string;
  chainId: string;
  ownerAccount: string;
  contracts: { cis8004: string; cis8: string };
  agents: RegisteredAgent[];
};

export type PassportDeps = {
  /** Absolute path to config/concordium-agents.json. */
  configPath: string;
  /** Directory holding agents/<slug>/agent-card.json. */
  agentsDir: string;
  log: { warn: (o: object, m?: string) => void };
};

type Loaded = {
  config: RegistryConfig | null;
  cards: Map<string, string>;
};

let cached: { key: string; value: Loaded } | null = null;

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function load(d: PassportDeps): Loaded {
  const key = `${d.configPath}\u0000${d.agentsDir}`;
  if (cached?.key === key) return cached.value;
  const parsed = readJson<RegistryConfig>(d.configPath);
  const agents = Array.isArray(parsed?.agents) ? parsed.agents : [];
  const config = parsed && agents.length > 0 ? parsed : null;
  const cards = new Map<string, string>();
  for (const a of agents) {
    const path = join(d.agentsDir, a.slug, 'agent-card.json');
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8');
    if (sha256Hex(raw) !== a.cardSha256) {
      // Serving changed bytes would fail the on-chain hash check anyway.
      d.log.warn({ slug: a.slug, path }, 'agent card does not match the pinned hash; not served');
      continue;
    }
    cards.set(a.slug, raw);
  }
  const value = { config, cards };
  cached = { key, value };
  return value;
}

/** Test seam: drop the cache so a new config is picked up. */
export function resetPassportCache(): void {
  cached = null;
}

export function passportRoutes(d: PassportDeps) {
  const state = () => load(d);
  const bySlug = (slug: string) => state().config?.agents.find((a) => a.slug === slug) ?? null;

  return {
    /** GET /agents -> HTML for a browser, JSON for a machine. */
    index(accept = ''): Response {
      const { config } = state();
      if (!config) return Response.json({ error: 'not_registered' }, { status: 404 });
      if (!accept.includes('text/html')) {
        return Response.json(indexSummary(config), {
          headers: { 'cache-control': 'public, max-age=300' },
        });
      }
      return htmlResponse(indexHtml(config));
    },

    /** GET /agents/passport.css -> the one stylesheet the passport pages load. */
    css(): Response {
      return new Response(PASSPORT_CSS, {
        headers: {
          'content-type': 'text/css; charset=utf-8',
          'cache-control': 'public, max-age=86400',
          'x-content-type-options': 'nosniff',
        },
      });
    },

    /** GET /agents/:slug/agent-card.json -> the pinned bytes, verbatim. */
    cardJson(slug: string): Response {
      const agent = bySlug(slug);
      const raw = state().cards.get(slug);
      if (!agent) return Response.json({ error: 'not_found' }, { status: 404 });
      if (!raw) return Response.json({ error: 'card_unavailable' }, { status: 503 });
      return new Response(raw, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=300',
          'x-content-type-options': 'nosniff',
        },
      });
    },

    /** GET /agents/:slug -> a plain HTML passport page. Public, no PII. */
    page(slug: string): Response {
      const agent = bySlug(slug);
      const { config } = state();
      if (!agent || !config) return notFoundHtml();
      return htmlResponse(pageHtml(agent, config));
    },

    /** GET /agents/:slug/card.png -> the crew mark as a square PNG. */
    async image(slug: string): Promise<Response> {
      const agent = bySlug(slug);
      if (!agent) return new Response('not found', { status: 404 });
      const png = await renderMark(agent.slug);
      return new Response(png, {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=3600',
          'x-content-type-options': 'nosniff',
        },
      });
    },

    /** GET /.well-known/agent-card.json -> Penny's pinned card. */
    wellKnown(): Response {
      const penny = bySlug('penny');
      const raw = state().cards.get('penny');
      if (!penny || !raw) return Response.json({ error: 'card_unavailable' }, { status: 503 });
      return new Response(raw, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=300',
          'x-content-type-options': 'nosniff',
        },
      });
    },
  };
}

/** The machine-readable crew summary, also written as /agents/index.json. */
export function indexSummary(config: RegistryConfig) {
  return {
    network: config.network,
    chainId: config.chainId,
    ownerAccount: config.ownerAccount,
    contracts: config.contracts,
    agents: config.agents.map((a) => ({
      slug: a.slug,
      name: a.name,
      tokenId: a.tokenId,
      badge: a.badge,
      cardUrl: a.cardUrl,
      cardSha256: a.cardSha256,
      verifyUrl: a.explorer.verify,
    })),
  };
}

export function indexHtml(config: RegistryConfig): string {
  const items = config.agents
    .map(
      (a) => `      <li><a href="/agents/${esc(a.slug)}">${esc(a.name)}</a>
        <span class="mono">${esc(a.badge)}</span></li>`,
    )
    .join('\n');
  return `<!doctype html>
${head(`${config.agents.length} agents — verified by Concordium`, 'Penny crew')}
<body>
<main>
  <div class="card">
    <h1>The Penny crew</h1>
    <p class="sub">${config.agents.length} agents, one owner, each with a Verified by Concordium badge.</p>
    <ul class="crew">
${items}
    </ul>
    <dl class="meta">
      <dt>Owner</dt><dd>${esc(config.ownerAccount)}</dd>
      <dt>Registry</dt><dd>CIS-8004 ${esc(config.contracts.cis8004)} on ${esc(config.network)}</dd>
    </dl>
    <p class="note">A badge proves the owner account published this card and controls it. It does not prove an agent is safe, correct, or honest, and it is not a payment guarantee.</p>
  </div>
</main>
</body>
</html>`;
}

export function pageHtml(agent: RegisteredAgent, config: RegistryConfig): string {
  const rows: [string, string][] = [
    ['Agent', agent.name],
    ['Registry', `CIS-8004 ${config.contracts.cis8004} on ${config.network}`],
    ['Token id', agent.tokenId],
    ['Owner', config.ownerAccount],
    ['Badge', agent.badge],
    ['Card SHA-256', agent.cardSha256],
    ['Registered', agent.registerTx],
    ['Card pinned', agent.pinTx],
  ];
  return `<!doctype html>
${head(`${agent.name} — verified by Concordium`, `${agent.name} carries a Verified by Concordium badge in the CIS-8004 agent registry.`)}
<body>
<main>
  <div class="card">
    <h1>${esc(agent.name)}</h1>
    <p class="sub">An agent in the Penny crew.</p>
    <div class="badge">Verified by Concordium</div>
    <dl>
${rows.map(([k, v]) => `      <dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('\n')}
    </dl>
    <div class="links">
      <a href="${esc(agent.explorer.verify)}">Check the badge</a>
      <a href="/agents/${esc(agent.slug)}/agent-card.json">Agent Card</a>
      <a href="${esc(agent.explorer.register)}">Registration</a>
      <a href="${esc(agent.explorer.pin)}">Card pin</a>
      <a href="/agents">The whole crew</a>
    </div>
    <p class="note">The badge proves the owner account published this card and controls it. It does not prove the agent is safe, correct, or honest, and it is not a payment guarantee.</p>
  </div>
</main>
</body>
</html>`;
}

/** Exported so the static exporter writes exactly the stylesheet the routes serve. */
export const PASSPORT_CSS = `:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:40px 20px;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#f6f7f8;color:#111519}
main{max-width:680px;margin:0 auto}
.card{background:#fff;border:1px solid #e3e5e8;border-radius:16px;padding:28px}
h1{margin:0 0 4px;font-size:26px;letter-spacing:-.02em}
.sub{margin:0 0 24px;color:#5b6169}
.badge{display:inline-block;margin-bottom:20px;padding:6px 12px;border-radius:999px;background:#111519;color:#fff;font-size:13px}
dl{margin:0;display:grid;grid-template-columns:128px 1fr;gap:10px 16px}
dt{color:#5b6169;font-size:13px;padding-top:2px}
dd{margin:0;font-size:13px;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
a{color:#111519;text-underline-offset:3px}
.links{margin-top:24px;display:flex;flex-wrap:wrap;gap:16px;font-size:14px}
.crew{margin:0;padding:0;list-style:none}
.crew li{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid #eef0f2;font-size:15px}
.crew li:last-child{border-bottom:0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#5b6169;word-break:break-all}
.meta{margin:20px 0 0}
.note{margin:24px 0 0;padding-top:20px;border-top:1px solid #e3e5e8;color:#5b6169;font-size:13px}`;

function head(title: string, description: string): string {
  return `<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<link rel="stylesheet" href="/agents/passport.css" />
</head>`;
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}

function notFoundHtml(): Response {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Not found</title><p>No such agent here.</p>',
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

let resvg: { renderPng: (svg: string) => Promise<Uint8Array> } | null = null;

async function renderMark(slug: string): Promise<Uint8Array> {
  if (!resvg) {
    const { Resvg } = await import('@resvg/resvg-js');
    resvg = {
      renderPng: async (svg: string) =>
        new Uint8Array(new Resvg(svg, { fitTo: { mode: 'width', value: 512 } }).render().asPng()),
    };
  }
  return resvg.renderPng(markSvg(slug));
}

/** Brand-neutral square mark. Penny and Guard reuse the shapes already in render.ts. */
function markSvg(slug: string): string {
  const art =
    slug === 'penny'
      ? '<circle cx="256" cy="216" r="150" fill="#fff"/><path d="M138 216 L138 392 C138 424 162 444 190 444 C218 444 242 424 242 392 L242 332 C210 322 182 294 164 266 Z" fill="#fff"/><rect x="138" y="216" width="112" height="126" fill="#fff"/><rect x="247" y="158" width="40" height="88" rx="20" fill="#111519"/><rect x="327" y="158" width="40" height="88" rx="20" fill="#111519"/>'
      : slug === 'guard'
        ? '<path d="M256 76 C316 106 372 117 418 119 C418 288 372 382 256 440 C140 382 94 288 94 119 C140 117 196 106 256 76Z" fill="#111519"/><rect x="196" y="196" width="40" height="88" rx="20" fill="#fff"/><rect x="276" y="196" width="40" height="88" rx="20" fill="#fff"/>'
        : slug === 'invest'
          ? '<path d="M120 340 L206 236 L272 292 L392 156" fill="none" stroke="#111519" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/><circle cx="392" cy="156" r="26" fill="#111519"/>'
          : '<rect x="112" y="164" width="288" height="184" rx="20" fill="none" stroke="#111519" stroke-width="30"/><path d="M112 208 L400 208" stroke="#111519" stroke-width="30"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><rect width="512" height="512" rx="112" fill="#fff"/>${art}</svg>`;
}
