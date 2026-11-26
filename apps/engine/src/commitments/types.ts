import type { Cadence } from '../repo/commitments.ts';

/** What the new-bill text needs from the obligation this bill belongs to. */
export type BillContext = {
  commitmentId: string;
  repeat: boolean;
  cadence: Cadence | null;
  previousAmount: string | null;
  previousCurrency: 'NGN' | 'USD' | null;
  /** The one sentence comparing this bill with the last one. */
  repeatLine: string;
};
