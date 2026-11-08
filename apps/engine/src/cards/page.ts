import type { Card } from '@penny/shared';
import { cardSentence, esc, OG_HEIGHT, OG_WIDTH } from './render.ts';

/**
 * The link card page: the web app shell (apps/web build) with Open Graph tags
 * for the card's current state, so iMessage shows it as a rich picture card.
 * Without a web build, a minimal page with the same tags is served.
 */
export function linkPageHtml(input: {
  shell: string | null;
  card: Card | null;
  imageUrl: string | null;
  pageUrl: string;
  now: Date;
}): string {
  const title = input.card ? input.card.title : 'Penny';
  const desc = input.card
    ? cardSentence(input.card, input.now)
    : 'This card is gone. Ask Penny for a fresh one.';
  const tags = [
    `<meta property="og:site_name" content="Penny" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(desc)}" />`,
    `<meta property="og:url" content="${esc(input.pageUrl)}" />`,
    ...(input.imageUrl
      ? [
          `<meta property="og:image" content="${esc(input.imageUrl)}" />`,
          `<meta property="og:image:type" content="image/png" />`,
          `<meta property="og:image:width" content="${OG_WIDTH}" />`,
          `<meta property="og:image:height" content="${OG_HEIGHT}" />`,
          `<meta property="og:image:alt" content="${esc(desc)}" />`,
          `<meta name="twitter:card" content="summary_large_image" />`,
        ]
      : []),
    `<meta name="robots" content="noindex" />`,
    `<meta name="referrer" content="no-referrer" />`,
  ].join('\n    ');
  if (input.shell) {
    return input.shell
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)} · Penny</title>`)
      .replace('</head>', `    ${tags}\n  </head>`);
  }
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)} · Penny</title>
    ${tags}
  </head>
  <body>
    <h1>${esc(title)}</h1>
    <p>${esc(desc)}</p>
  </body>
</html>`;
}

/** The setup link's picture card (the code itself rides in the URL fragment). */
export const SETUP_CARD: Card = {
  id: 'crd_00000000000000000000000000',
  userId: 'setup',
  agent: 'penny',
  kind: 'info',
  type: 'setup',
  title: 'Set up Penny',
  lines: [
    { value: 'Link this phone so you can approve with Face ID.' },
    { value: 'Your key stays on your phone.' },
  ],
  buttons: [{ id: 'setup', label: 'Tap to set up', action: 'open' }],
  state: 'ready',
  createdAt: '2026-11-08T00:00:00.000Z',
};
