import { describe, expect, it } from 'bun:test';
import { atomicToCcd, quoteService } from '../src/brain/x402.ts';

function paid(requirements: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const header = Buffer.from(
    JSON.stringify({ x402Version: 2, accepts: [requirements], ...extra }),
  ).toString('base64');
  return new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': header } });
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('atomicToCcd', () => {
  it('converts atomic CCD without floating point', () => {
    expect(atomicToCcd('500000')).toBe('0.5');
    expect(atomicToCcd('1000000')).toBe('1');
    expect(atomicToCcd('1')).toBe('0.000001');
    expect(atomicToCcd('1230000')).toBe('1.23');
    expect(atomicToCcd('0')).toBe('0');
  });

  it('leaves anything that is not a plain integer alone', () => {
    expect(atomicToCcd('0.5')).toBe('0.5');
    expect(atomicToCcd('-1')).toBe('-1');
    expect(atomicToCcd('')).toBe('');
  });
});

describe('quoteService', () => {
  it('reads a price from a 402 challenge and never pays', async () => {
    let asked = '';
    const quote = await quoteService('http://seller.test/guard/review', async (url) => {
      asked = String(url);
      return paid({
        scheme: 'exact',
        network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
        payTo: '3ewJGpdgo6NcDt36tmhnakMv9YB1qBQNPQBAinEJy9T1dpujfT',
        price: { amount: '500000', asset: 'CCD' },
        description: 'ACME Ltd company check',
      });
    });

    expect(asked).toBe('http://seller.test/guard/review');
    expect(quote.ok).toBe(true);
    if (!quote.ok || !quote.needsPayment) throw new Error('expected a priced quote');
    expect(quote.amountAtomic).toBe('500000');
    expect(quote.amountCcd).toBe('0.5');
    expect(quote.asset).toBe('CCD');
    expect(quote.payTo).toBe('3ewJGpdgo6NcDt36tmhnakMv9YB1qBQNPQBAinEJy9T1dpujfT');
    expect(quote.network).toBe('ccd:4221332d34e1694168c2a0c0b3fd0f27');
    expect(quote.description).toBe('ACME Ltd company check');
  });

  it('reads the shape @x402/concordium really sends', async () => {
    // Captured verbatim from the running seller, not invented: amount at the
    // top level and resource as an object.
    const quote = await quoteService(
      'http://localhost:4020/guard/review?topic=acme-ltd',
      async () =>
        paid({
          scheme: 'exact',
          network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
          amount: '500000',
          asset: 'CCD',
          payTo: '3ewJGpdgo6NcDt36tmhnakMv9YB1qBQNPQBAinEJy9T1dpujfT',
          maxTimeoutSeconds: 300,
          extra: { feePayer: '3ewJGpdgo6NcDt36tmhnakMv9YB1qBQNPQBAinEJy9T1dpujfT' },
        }),
    );
    expect(quote.ok).toBe(true);
    if (!quote.ok || !quote.needsPayment) throw new Error('expected a priced quote');
    expect(quote.amountAtomic).toBe('500000');
    expect(quote.amountCcd).toBe('0.5');
    expect(quote.asset).toBe('CCD');
  });

  it('takes the description from a resource object when present', async () => {
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        error: 'Payment required',
        resource: {
          url: 'http://localhost:4020/guard/review',
          description: 'Guard reviews a plan and returns a risk note.',
          mimeType: 'application/json',
        },
        accepts: [
          {
            scheme: 'exact',
            network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
            amount: '500000',
            asset: 'CCD',
            payTo: '3ewJGpdgo6NcDt36tmhnakMv9YB1qBQNPQBAinEJy9T1dpujfT',
          },
        ],
      }),
    ).toString('base64');

    const quote = await quoteService(
      'http://localhost:4020/guard/review',
      async () => new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': header } }),
    );
    expect(quote.ok).toBe(true);
    if (!quote.ok || !quote.needsPayment) throw new Error('expected a priced quote');
    expect(quote.description).toBe('Guard reviews a plan and returns a risk note.');
  });

  it('reports a free resource as needing no payment', async () => {
    const quote = await quoteService('http://seller.test/free', async () => ok({ fine: true }));
    expect(quote).toEqual({ ok: true, status: 200, needsPayment: false });
  });

  it('reads older servers that put the amount in maxAmountRequired', async () => {
    const quote = await quoteService(
      'http://seller.test/old',
      async () =>
        new Response(null, {
          status: 402,
          headers: {
            'PAYMENT-REQUIRED': Buffer.from(
              JSON.stringify({
                x402Version: 1,
                accepts: [
                  {
                    scheme: 'exact',
                    network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
                    payTo: '3ewJGpdgo6NcDt36tmhnakMv9YB1qBQNPQBAinEJy9T1dpujfT',
                    maxAmountRequired: '2000000',
                    asset: 'CCD',
                  },
                ],
              }),
            ).toString('base64'),
          },
        }),
    );
    expect(quote.ok).toBe(true);
    if (!quote.ok || !quote.needsPayment) throw new Error('expected a priced quote');
    expect(quote.amountCcd).toBe('2');
  });

  it('refuses to invent a price when the header is unreadable', async () => {
    const bad = await quoteService(
      'http://seller.test/x',
      async () =>
        new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': 'not base64!!' } }),
    );
    expect(bad).toEqual({ ok: false, error: "I couldn't read that agent's price" });
  });

  it('refuses when a 402 names no price at all', async () => {
    const bare = await quoteService(
      'http://seller.test/x',
      async () => new Response(null, { status: 402 }),
    );
    expect(bare).toEqual({ ok: false, error: 'that agent wants paying but named no price' });
  });

  it('surfaces an unexpected status instead of pretending it is a quote', async () => {
    const quote = await quoteService(
      'http://seller.test/down',
      async () => new Response('boom', { status: 500 }),
    );
    expect(quote).toEqual({ ok: false, error: 'that agent answered 500' });
  });

  it('says so when the peer cannot be reached', async () => {
    const quote = await quoteService('http://seller.test/x', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(quote).toEqual({ ok: false, error: "I can't reach that agent right now." });
  });
});
