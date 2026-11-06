/**
 * Read-only Composio smoke check. Requires COMPOSIO_API_KEY in env.
 * Creates a session for COMPOSIO_TEST_USER_ID (or 'penny-smoke') and lists
 * the gated tool names. Never executes a real app tool.
 * Run: COMPOSIO_API_KEY=... bun apps/engine/scripts/composio-smoke.ts
 */
import { ComposioConnector } from '../src/connectors/composio.ts';

const key = process.env.COMPOSIO_API_KEY;
if (!key) {
  console.error('COMPOSIO_API_KEY is not set');
  process.exit(1);
}
const userId = process.env.COMPOSIO_TEST_USER_ID ?? 'penny-smoke';
const connector = new ComposioConnector(key);
const tools = await connector.toolsFor(userId, 'mail');
console.log(`user=${userId} gated tools (${Object.keys(tools).length}):`);
for (const name of Object.keys(tools).sort()) console.log(` - ${name}`);
