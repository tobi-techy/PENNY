/**
 * Known billers. This list is the ONLY source of where a bill payment may go:
 * the model and the email never choose a payee account. `payTo` stays unset
 * until a biller has a verified way to receive USDC on NEAR (or, later, a
 * naira payment rail). A bill whose biller has no `payTo` can be detected and
 * reminded about, but not paid.
 *
 * Matching is deliberately simple and conservative: sender domain first, then
 * whole-word keywords in the sender name or subject.
 */
export type Biller = {
  id: string;
  name: string;
  category: 'tv' | 'electricity' | 'internet' | 'airtime' | 'water' | 'other';
  /** Sender email domains (suffix match, lowercase). */
  domains: string[];
  /** Whole-word, case-insensitive keywords for the sender name or subject. */
  keywords: string[];
  currency: 'NGN' | 'USD';
  /** Verified NEAR account that receives USDC for this biller. Unset = not payable yet. */
  payTo?: string;
};

export const BILLERS: readonly Biller[] = [
  {
    id: 'dstv',
    name: 'DStv',
    category: 'tv',
    domains: ['dstv.com', 'multichoice.com', 'multichoice.co.za', 'dstvafrica.com'],
    keywords: ['dstv'],
    currency: 'NGN',
  },
  {
    id: 'gotv',
    name: 'GOtv',
    category: 'tv',
    domains: ['gotvafrica.com', 'gotv.com'],
    keywords: ['gotv'],
    currency: 'NGN',
  },
  {
    id: 'startimes',
    name: 'StarTimes',
    category: 'tv',
    domains: ['startimes.com.ng', 'startimestv.com'],
    keywords: ['startimes'],
    currency: 'NGN',
  },
  {
    id: 'ikedc',
    name: 'IKEDC',
    category: 'electricity',
    domains: ['ikejaelectric.com'],
    keywords: ['ikedc', 'ikeja electric'],
    currency: 'NGN',
  },
  {
    id: 'ekedc',
    name: 'EKEDC',
    category: 'electricity',
    domains: ['ekedp.com', 'ekedc.com'],
    keywords: ['ekedc', 'ekedp', 'eko electricity'],
    currency: 'NGN',
  },
  {
    id: 'aedc',
    name: 'AEDC',
    category: 'electricity',
    domains: ['abujaelectricity.com'],
    keywords: ['aedc', 'abuja electricity'],
    currency: 'NGN',
  },
  {
    id: 'spectranet',
    name: 'Spectranet',
    category: 'internet',
    domains: ['spectranet.com.ng'],
    keywords: ['spectranet'],
    currency: 'NGN',
  },
  {
    id: 'mtn',
    name: 'MTN',
    category: 'airtime',
    domains: ['mtn.com', 'mtn.ng', 'mtnonline.com'],
    keywords: ['mtn'],
    currency: 'NGN',
  },
  {
    id: 'airtel',
    name: 'Airtel',
    category: 'airtime',
    domains: ['airtel.com.ng', 'ng.airtel.com'],
    keywords: ['airtel'],
    currency: 'NGN',
  },
];

const BY_ID = new Map(BILLERS.map((b) => [b.id, b]));

export function billerById(id: string | null | undefined): Biller | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** "Name <bills@x.com>" -> { name: "Name", domain: "x.com" }. */
export function splitSender(sender: string): { name: string; domain: string | null } {
  const email = sender.match(/<([^>]+)>/)?.[1] ?? (sender.includes('@') ? sender : '');
  const domain = email.split('@')[1]?.trim().toLowerCase().replace(/>$/, '') || null;
  const name =
    sender
      .replace(/<[^>]*>/, '')
      .replace(/"/g, '')
      .trim() ||
    email ||
    sender;
  return { name: name.slice(0, 80), domain };
}

function wordMatch(hay: string, kw: string): boolean {
  const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(hay);
}

/** Match a bill email to a known biller, or undefined. */
export function matchBiller(sender: string, subject: string): Biller | undefined {
  const { name, domain } = splitSender(sender);
  if (domain) {
    for (const b of BILLERS)
      if (b.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return b;
  }
  for (const b of BILLERS)
    if (b.keywords.some((k) => wordMatch(name, k) || wordMatch(subject, k))) return b;
  return undefined;
}
