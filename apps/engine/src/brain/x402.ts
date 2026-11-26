import { z } from 'zod';

/**
 * Reading a price from another agent (x402).
 *
 * This is the buyer's first half: ask a peer agent what it charges, and report
 * it without spending. Paying is deliberately not here — see the note at the
 * bottom of this file.
 */

const Price = z.union([
  z.string(),
  z.object({ amount: z.string(), asset: z.string().optional() }).passthrough(),
]);

/** Either a bare URL or `{url, description, mimeType}`, depending on the server. */
const Resource = z.union([
  z.string(),
  z
    .object({
      url: z.string().optional(),
      description: z.string().optional(),
      mimeType: z.string().optional(),
    })
    .passthrough(),
]);

const Requirement = z
  .object({
    scheme: z.string().min(1),
    network: z.string().min(1),
    payTo: z.string().min(1),
    /** What @x402/concordium actually sends: the amount sits at the top level. */
    amount: z.string().optional(),
    price: Price.optional(),
    /** Older x402 servers put the amount here. */
    maxAmountRequired: z.string().optional(),
    asset: z.string().optional(),
    resource: Resource.optional(),
    description: z.string().optional(),
  })
  .passthrough();

const PaymentRequired = z
  .object({
    x402Version: z.number(),
    accepts: z.array(Requirement).min(1),
    /** @x402/concordium describes the resource here rather than per requirement. */
    resource: Resource.optional(),
  })
  .passthrough();

export type ServiceQuote =
  | { ok: true; status: number; needsPayment: false }
  | {
      ok: true;
      status: 402;
      needsPayment: true;
      network: string;
      scheme: string;
      payTo: string;
      /** Atomic units, as sent. CCD has 6 decimals. */
      amountAtomic: string;
      /** The same amount in CCD, for plain speech. */
      amountCcd: string;
      asset: string;
      description?: string;
    }
  | { ok: false; error: string };

/** Atomic CCD (6 decimals) to a plain decimal string, without floating point. */
export function atomicToCcd(atomic: string): string {
  if (!/^\d+$/.test(atomic)) return atomic;
  const n = BigInt(atomic);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function amountOf(r: z.infer<typeof Requirement>): { atomic: string; asset: string } | null {
  const raw =
    typeof r.price === 'string'
      ? r.price
      : r.price && typeof r.price === 'object'
        ? r.price.amount
        : (r.amount ?? r.maxAmountRequired);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const asset =
    (r.price && typeof r.price === 'object' ? r.price.asset : undefined) ?? r.asset ?? 'CCD';
  return { atomic: raw, asset };
}

/** A short "what is this" line, wherever the server happened to put it. */
function describe(
  r: z.infer<typeof Requirement>,
  top: z.infer<typeof PaymentRequired>,
): string | undefined {
  if (r.description) return r.description;
  if (r.resource && typeof r.resource === 'object' && r.resource.description) {
    return r.resource.description;
  }
  if (top.resource && typeof top.resource === 'object') return top.resource.description;
  return undefined;
}

/**
 * Ask what a paid resource costs. Never sends a payment: it reads the 402
 * challenge and stops, so this is safe to call on every turn.
 */
export type QuoteFetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function quoteService(
  url: string,
  fetchImpl: QuoteFetch = fetch,
): Promise<ServiceQuote> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch {
    return { ok: false, error: "I can't reach that agent right now." };
  }

  if (res.status === 200) return { ok: true, status: 200, needsPayment: false };
  if (res.status !== 402) return { ok: false, error: `that agent answered ${res.status}` };

  const header = res.headers.get('PAYMENT-REQUIRED') ?? res.headers.get('payment-required');
  if (!header) return { ok: false, error: 'that agent wants paying but named no price' };

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return { ok: false, error: "I couldn't read that agent's price" };
  }

  const parsed = PaymentRequired.safeParse(json);
  if (!parsed.success) return { ok: false, error: "I couldn't read that agent's price" };

  // Servers may offer several ways to pay; report the first in the list.
  const r = parsed.data.accepts[0];
  if (!r) return { ok: false, error: "I couldn't read that agent's price" };
  const amount = amountOf(r);
  if (!amount) return { ok: false, error: "I couldn't read that agent's price" };
  const what = describe(r, parsed.data);

  return {
    ok: true,
    status: 402,
    needsPayment: true,
    network: r.network,
    scheme: r.scheme,
    payTo: r.payTo,
    amountAtomic: amount.atomic,
    amountCcd: atomicToCcd(amount.atomic),
    asset: amount.asset,
    ...(what ? { description: what } : {}),
  };
}

// Paying is not in this file on purpose. Every money move in Penny goes
// Guard -> approval card -> NEP-366 delegate action, and x402 has no plan kind
// in that model yet. Routing a spend around Guard to make a demo work would
// quietly break the rule that the model never moves money, so the paying half
// waits for a proper `x402` MoneyPlan rather than a shortcut here.
//
// It is also still blocked downstream: settlement is refused with
// `sponsor_as_sender` until testnet has three distinct accounts. See
// docs/CONCORDIUM-AGENT-PAYMENTS.md.
