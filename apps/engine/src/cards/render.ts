import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalPill, type Card, cardStyle, crewColor, settledPill } from '@penny/shared';

/**
 * Server-side card picture (1200x630 PNG) for link cards (og:image) and the
 * live card's layout image. Same design as design/card/card.html: dark card,
 * Bayer 4x4 dither art in the type colour, crew chip, mono tag, big number,
 * fact rows, one pill. Plain SVG rasterised with resvg; no browser.
 */

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const FONT_DIR = join(import.meta.dir, '..', '..', 'assets', 'fonts');
const FONT_FILES = ['Geist-Regular.otf', 'Geist-Medium.otf', 'GeistMono-Regular.otf'].map((f) =>
  join(FONT_DIR, f),
);

const C = {
  bg: '#080D14',
  border: '#1E2A38',
  ink: '#F1F5FA',
  meta: '#B1C3D8',
  dim: '#4A5563',
  okBg: '#0A2E27',
  ok: '#8FE4CC',
  redBg: '#3A1214',
  red: '#FF9C9C',
};

// Crew marks (brand/assets), inlined so the engine image needs no brand/ folder.
const PENNY_MARK =
  '<circle cx="290" cy="216" r="158" fill="#fff"/><path d="M132 216 L132 404 C132 438 158 460 188 460 C218 460 244 438 244 404 L244 340 C210 330 180 300 160 270 Z" fill="#fff"/><rect x="132" y="216" width="120" height="134" fill="#fff"/><rect x="247" y="154" width="42" height="92" rx="21" fill="#111519"/><rect x="331" y="154" width="42" height="92" rx="21" fill="#111519"/>';
const GUARD_MARK =
  '<path d="M256 64 C320 96 380 108 430 110 C430 290 380 390 256 452 C132 390 82 290 82 110 C132 108 192 96 256 64Z" fill="#111519"/><rect x="193" y="190" width="42" height="92" rx="21" fill="#fff"/><rect x="277" y="190" width="42" height="92" rx="21" fill="#fff"/>';

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** "1:30 left" for live approvals, else a short state word. Plain words. */
export function trailingFor(card: Pick<Card, 'state' | 'expiresAt'>, now: Date): string {
  if (card.state === 'ready' && card.expiresAt) {
    const secs = Math.max(0, Math.floor((Date.parse(card.expiresAt) - now.getTime()) / 1000));
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} left`;
  }
  switch (card.state) {
    case 'approving':
      return 'approving';
    case 'sent':
      return 'sent';
    case 'blocked':
      return 'blocked';
    case 'expired':
      return '0:00';
    case 'declined':
      return 'you said no';
    case 'failed':
      return "didn't go through";
    case 'undone':
      return 'undone';
    default:
      return '';
  }
}

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** The dithered hill from card.html, as rects. Calm for settled cards, grey when expired. */
function ditherArt(color: string, state: Card['state'], w: number, h: number): string {
  const px = 10;
  const calm = state === 'sent' || state === 'done';
  const fill = state === 'expired' || state === 'undone' ? C.dim : color;
  const amp = calm ? 0.1 : 0.22;
  const out: string[] = [];
  for (let y = 0; y < h; y += px) {
    for (let x = 0; x < w; x += px) {
      const nx = x / w;
      const ny = y / h;
      const ridge =
        0.62 -
        amp * Math.exp(-((nx - 0.62) ** 2) / 0.05) -
        0.08 * Math.sin(nx * 9 + (calm ? 1 : 0));
      let v =
        ny > ridge ? 0.85 - (ny - ridge) * 1.2 : 0.18 * Math.exp(-((ny - ridge) ** 2) / 0.004);
      v *= 0.35 + 0.65 * Math.exp(-((nx - 0.6) ** 2) / 0.12);
      const th = ((BAYER[(y / px) % 4]?.[(x / px) % 4] ?? 0) + 0.5) / 16;
      if (v > th) {
        out.push(
          `<rect x="${x}" y="${y}" width="${px - 2}" height="${px - 2}" fill-opacity="${(0.55 + 0.45 * v).toFixed(2)}"/>`,
        );
      }
    }
  }
  return `<g fill="${fill}">${out.join('')}</g>`;
}

export function buildCardSvg(card: Card, now: Date): string {
  const W = OG_WIDTH;
  const H = OG_HEIGHT;
  const style = cardStyle(card.type);
  const artH = 220;
  const blocked = card.state === 'blocked' || card.type === 'guard_block';
  const accent = blocked ? '#FC5855' : style.color;
  // tag text without the leading symbol (Geist has no glyph for most of them)
  const tagWord = style.tag.replace(/^\S+\s+/, '');
  const tagW = 58 + Math.ceil(tagWord.length * 12.6);
  const trailing = trailingFor(card, now);
  const mark = card.agent === 'guard' ? GUARD_MARK : PENNY_MARK;

  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`);
  parts.push(ditherArt(accent, card.state, W, artH));
  parts.push(
    `<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.5" stop-color="${C.bg}" stop-opacity="0"/><stop offset="1" stop-color="${C.bg}" stop-opacity="1"/></linearGradient></defs>`,
    `<rect width="${W}" height="${artH}" fill="url(#fade)"/>`,
  );
  // crew chip
  parts.push(
    `<circle cx="84" cy="76" r="38" fill="${crewColor(card.agent)}"/>`,
    `<svg x="58" y="50" width="52" height="52" viewBox="0 0 512 512">${mark}</svg>`,
  );
  // tag + trailing meta
  const tagBg = blocked ? C.redBg : '#0F1A26';
  parts.push(
    `<rect x="56" y="246" width="${tagW}" height="40" rx="20" fill="${tagBg}"/>`,
    `<circle cx="78" cy="266" r="6" fill="${blocked ? C.red : accent}"/>`,
    `<text x="94" y="273" font-family="Geist Mono" font-size="19" letter-spacing="1.5" fill="${blocked ? C.red : accent}">${esc(tagWord)}</text>`,
  );
  if (trailing) {
    parts.push(
      `<text x="${W - 56}" y="274" text-anchor="end" font-family="Geist Mono" font-size="22" fill="${C.meta}">${esc(trailing)}</text>`,
    );
  }
  // title + big number (left column)
  parts.push(
    `<text x="56" y="342" font-family="Geist" font-size="36" fill="${C.ink}">${esc(clip(card.title, 34))}</text>`,
  );
  if (card.amount) {
    parts.push(
      `<text x="56" y="436" font-family="Geist" font-size="78" letter-spacing="-2" fill="${C.ink}">${esc(clip(card.amount, 14))}</text>`,
    );
  }
  // fact rows (right column)
  const rows = card.lines.slice(0, 4);
  const rx = 640;
  let ry = 320;
  parts.push(
    `<rect x="${rx}" y="${ry - 6}" width="${W - 56 - rx}" height="1" fill="#FFFFFF" fill-opacity="0.10"/>`,
  );
  for (const l of rows) {
    ry += 46;
    if (l.label) {
      parts.push(
        `<text x="${rx}" y="${ry - 14}" font-family="Geist" font-size="22" fill="${C.meta}">${esc(clip(l.label, 18))}</text>`,
        `<text x="${W - 56}" y="${ry - 14}" text-anchor="end" font-family="Geist" font-size="22" fill="${C.ink}">${esc(clip(l.value, 26))}</text>`,
      );
    } else {
      parts.push(
        `<text x="${rx}" y="${ry - 14}" font-family="Geist" font-size="22" fill="${C.ink}">${esc(clip(l.value, 40))}</text>`,
      );
    }
    parts.push(
      `<rect x="${rx}" y="${ry}" width="${W - 56 - rx}" height="1" fill="#FFFFFF" fill-opacity="0.07"/>`,
    );
  }
  // the pill
  const pillY = 524;
  const pillH = 64;
  let pill: { label: string; bg: string; fg: string } | null = null;
  if (card.kind === 'approval') {
    const label = approvalPill(card.state);
    if (card.state === 'ready') pill = { label: label ?? '', bg: '#FFFFFF', fg: '#111519' };
    else if (card.state === 'sent' || card.state === 'done')
      pill = { label: settledPill(card.type), bg: C.okBg, fg: C.ok };
    else if (card.state === 'blocked') pill = { label: label ?? 'Not me', bg: C.redBg, fg: C.red };
    else if (label) pill = { label, bg: '#FFFFFF1F', fg: C.ink };
    else if (card.state === 'declined')
      pill = { label: 'You said no. Nothing moved.', bg: '#FFFFFF14', fg: C.meta };
    else if (card.state === 'failed')
      pill = { label: "Didn't go through. Nothing moved.", bg: '#FFFFFF14', fg: C.meta };
  } else if (card.state === 'done' && card.buttons.length === 0) {
    pill = { label: settledPill(card.type), bg: C.okBg, fg: C.ok };
  } else if (card.buttons.length) {
    // A Face ID action is the one white pill, exactly as on the live card.
    const faceId = card.buttons.some((b) => b.action === 'unfreeze');
    pill = {
      label: card.buttons.map((b) => b.label).join('  ·  '),
      bg: faceId ? '#FFFFFF' : '#FFFFFF1F',
      fg: faceId ? '#111519' : C.ink,
    };
  }
  if (pill) {
    parts.push(
      `<rect x="56" y="${pillY}" width="${W - 112}" height="${pillH}" rx="${pillH / 2}" fill="${pill.bg.slice(0, 7)}"${pill.bg.length > 7 ? ` fill-opacity="${(Number.parseInt(pill.bg.slice(7), 16) / 255).toFixed(2)}"` : ''}/>`,
      `<text x="${W / 2}" y="${pillY + 41}" text-anchor="middle" font-family="Geist" font-weight="500" font-size="26" fill="${pill.fg}">${esc(clip(pill.label, 60))}</text>`,
    );
  }
  parts.push(
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="${C.border}"/>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}

type ResvgCtor = new (svg: string, opts: unknown) => { render(): { asPng(): Uint8Array } };
let resvg: ResvgCtor | null = null;
let fontsOk: boolean | null = null;

/** Render the card as a 1200x630 PNG. */
export async function renderCardPng(card: Card, now: Date): Promise<Uint8Array> {
  if (!resvg) resvg = (await import('@resvg/resvg-js')).Resvg as unknown as ResvgCtor;
  if (fontsOk === null) {
    try {
      for (const f of FONT_FILES) readFileSync(f);
      fontsOk = true;
    } catch {
      fontsOk = false;
    }
  }
  const r = new resvg(buildCardSvg(card, now), {
    fitTo: { mode: 'width', value: OG_WIDTH },
    font: {
      ...(fontsOk ? { fontFiles: FONT_FILES } : {}),
      loadSystemFonts: !fontsOk,
      defaultFontFamily: 'Geist',
    },
  });
  return new Uint8Array(r.render().asPng());
}

/** One plain sentence for VoiceOver, og:description and the page title. */
export function cardSentence(card: Card, now: Date): string {
  const bits = [card.title];
  if (card.amount) bits.push(card.amount);
  for (const l of card.lines.slice(0, 2)) bits.push(l.label ? `${l.label} ${l.value}` : l.value);
  const t = trailingFor(card, now);
  if (t) bits.push(t);
  if (card.kind === 'approval' && card.state === 'ready') bits.push('Approve with Face ID');
  return bits.join('. ').replace(/\.\./g, '.');
}
