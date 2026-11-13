export type ConcordiumNetwork = 'testnet' | 'mainnet' | 'devnet';

export type BadgeVerdict = 'verified' | 'invalid' | 'revoked' | 'unknown' | 'unavailable';

export type BadgeIssue = {
  severity: string;
  field: string;
  message: string;
};

export type BadgeCheck = {
  tokenId: number | null;
  tokenAddress: string | null;
  agentUri: string | null;
  ownerAccount: string | null;
  status: string | null;
  badgeValid: boolean;
  checks: Record<string, boolean | string | null>;
  issues: BadgeIssue[];
  network: string;
  raw: unknown;
};

export type VerifyResult = {
  verdict: BadgeVerdict;
  badge: string;
  network: ConcordiumNetwork;
  checkedAt: string;
  check: BadgeCheck;
  error?: string;
};

/** The verdict for one owner account, with each of its agents. */
export type OwnerVerifyResult = VerifyResult & {
  account: string;
  /** Every agent the account owns, each checked independently. */
  agents: BadgeCheck[];
  validCount: number;
  invalidCount: number;
};
