import { describe, expect, test } from 'bun:test';
import type { ToolContext } from '../src/brain/registry.ts';
import { createRegistry } from '../src/brain/tools.ts';
import { FakeConnector } from '../src/connectors/composio.ts';
import { connectRequest } from '../src/inbound.ts';
import { stripExternalLinks, urlsIn } from '../src/lib/plain-text.ts';

describe('outbound links', () => {
  test('strips a raw connect URL from a reply', () => {
    expect(stripExternalLinks('tap to connect your gmail: https://connect.example/gmail\nok')).toBe(
      'tap to connect your gmail:\nok',
    );
  });

  test('keeps a URL the user just sent', () => {
    const sent = 'is https://example.com/x broken?';
    expect(stripExternalLinks('it looks fine: https://example.com/x', urlsIn(sent))).toContain(
      'https://example.com/x',
    );
  });

  test('connect_app never returns the raw provider link', async () => {
    const tool = createRegistry().get('connect_app');
    expect(tool).toBeDefined();
    const out = (await tool?.execute(
      { userId: 'u1', connectors: new FakeConnector() } as unknown as ToolContext,
      { toolkit: 'gmail' },
    )) as { sentCard: boolean; tellUser: string };
    expect(JSON.stringify(out)).not.toContain('https://connect.example');
    expect(out.sentCard).toBe(false);
    expect(out.tellUser).not.toContain('http');
  });

  test.each([
    ['connect my gmail', 'gmail'],
    ['Connect mail', 'gmail'],
    ['connect my email', 'gmail'],
    ['link my inbox', 'gmail'],
    ['set up github', 'github'],
  ])('%s asks for %s', (text, toolkit) => {
    expect(connectRequest(text)).toBe(toolkit as 'gmail' | 'github');
  });

  test.each([
    'disconnect gmail',
    "don't connect gmail",
    'is gmail connected?',
    'check my mail',
    'send mail to ada',
    'pay my bill',
  ])('%s does not ask for a connect card', (text) => {
    expect(connectRequest(text)).toBeNull();
  });
});
