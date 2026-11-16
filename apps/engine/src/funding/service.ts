import { type CardLine, Decimal, formatUsd, fromMicros, toMicros } from '@penny/shared';
import type { CardSender } from '../cards/sender.ts';
import type { Logger } from '../lib/logger.ts';
import {
  FUND_CHAIN_LABEL,
  type FundChain,
  type FundingPort,
  isFundChain,
} from '../market/funding.ts';
import type { MessagingPort, SpaceRef } from '../ports/messaging.ts';
import type { FundingRepo, FundingRow } from '../repo/funding.ts';
import type { UsersRepo } from '../repo/users.ts';

/** User copy when this deployment has no live funding rail (testnet, no 1Click). */
export const FUNDING_UNAVAILABLE =
  "adding money from another chain isn't switched on here yet. on testnet, ask me for test dollars.";
/** Below this, fees eat the deposit; also stops a $0.01 test from looking like a top-up. */
export const FUNDING_MIN_USD = '5';

export type FundingServiceDeps = {
  users: UsersRepo;
  cards: CardSender;
  messaging: MessagingPort;
  repo: FundingRepo;
  log: Logger;
  now: () => Date;
  timeZone: string;
  /** Absent = the rail is off (mainnet-only today: 1Click has no testnet). */
  funding?: FundingPort;
};

export type StartFundingInput = {
  userId: string;
  space: SpaceRef;
  amountUsd: string;
  chain: FundChain;
};

export type StartFundingResult =
  | { ok: true; chain: FundChain; amountUsd: string; depositAddress: string; expiresAt: string }
  | { ok: false; reasons: string[] };

/**
 * "Add $20" from another chain. Penny gives the user an address that can only
 * receive, texts it so it is copyable, and follows the deposit until the dollars
 * land on the user's own NEAR account. No Face ID: nothing leaves Penny, and the
 * address is not a key.
 */
export class FundingService {
  constructor(private readonly d: FundingServiceDeps) {}

  async chains(): Promise<FundChain[]> {
    if (!this.d.funding) return [];
    try {
      return await this.d.funding.chains();
    } catch {
      this.d.log.warn('funding token list unavailable');
      return [];
    }
  }

  async start(input: StartFundingInput): Promise<StartFundingResult> {
    if (!this.d.funding) return { ok: false, reasons: [FUNDING_UNAVAILABLE] };
    if (!Decimal.safeParse(input.amountUsd).success)
      return { ok: false, reasons: ['How much, in dollars?'] };
    if (toMicros(input.amountUsd) < toMicros(FUNDING_MIN_USD))
      return { ok: false, reasons: [`The smallest top-up is ${formatUsd(FUNDING_MIN_USD)}.`] };
    if (!isFundChain(input.chain))
      return { ok: false, reasons: ['Which chain is it coming from?'] };
    const chains = await this.chains();
    if (!chains.includes(input.chain)) {
      const label = FUND_CHAIN_LABEL[input.chain];
      return { ok: false, reasons: [`I can't take money from ${label} right now.`] };
    }
    const user = await this.d.users.byId(input.userId);
    if (!user?.accountId) return { ok: false, reasons: ['finish setting up Penny first'] };

    let q: Awaited<ReturnType<FundingPort['quote']>>;
    try {
      q = await this.d.funding.quote(input.chain, input.amountUsd, user.accountId);
    } catch (e) {
      this.d.log.warn({ chain: input.chain, err: (e as Error).name }, 'funding quote failed');
      return {
        ok: false,
        reasons: ["I couldn't get an address just now. Try again in a minute."],
      };
    }

    const usd = fromMicros(toMicros(input.amountUsd));
    const chainLabel = FUND_CHAIN_LABEL[input.chain];
    const lines: CardLine[] = [
      { label: 'Send exactly', value: `${usd} USDC on ${chainLabel}` },
      { label: 'To', value: q.depositAddress.slice(0, 120) },
      { label: 'Good until', value: this.clock(q.expiresAt) },
    ];
    let cardId: string | null = null;
    try {
      const sent = await this.d.cards.send({
        userId: input.userId,
        space: input.space,
        agent: 'penny',
        kind: 'info',
        type: 'fund',
        title: `Add ${formatUsd(input.amountUsd)} to Penny`.slice(0, 80),
        amount: formatUsd(input.amountUsd),
        lines,
        buttons: [],
        // Not done yet: this is the instruction, not the landing.
        state: 'ready',
      });
      cardId = sent.card.id;
    } catch (e) {
      this.d.log.warn({ err: (e as Error).name }, 'funding card failed');
      // The address is still usable; the text below carries it.
    }

    await this.d.repo.create({
      userId: input.userId,
      cardId,
      chain: input.chain,
      amountUsd: input.amountUsd,
      amountIn: q.amountIn.toString(),
      depositAddress: q.depositAddress,
      depositMemo: q.depositMemo ?? null,
      state: 'open',
      amountOutDisplay: null,
      expiresAt: q.expiresAt,
      lastCheckedAt: null,
    });

    // The card cannot be copied from. The address as text can.
    const memoLine = q.depositMemo
      ? `\nand add this note if your wallet asks: ${q.depositMemo}`
      : '';
    await this.d.messaging.sendText(
      input.space,
      `send exactly ${usd} USDC on ${chainLabel} to:\n${q.depositAddress}${memoLine}\ni'll text you when it lands.`,
    );

    return {
      ok: true,
      chain: input.chain,
      amountUsd: input.amountUsd,
      depositAddress: q.depositAddress,
      expiresAt: q.expiresAt.toISOString(),
    };
  }

  /** Poll every live top-up. Terminal states text once; expiry is silent. */
  async poll(now = this.d.now()): Promise<number> {
    if (!this.d.funding) return 0;
    const rows = await this.d.repo.live(50);
    let settled = 0;
    for (const row of rows) {
      if (row.expiresAt.getTime() <= now.getTime()) {
        const claimed = await this.d.repo.claim(row.id, 'expired', { lastCheckedAt: now });
        if (claimed && row.cardId) await this.setCard(row, 'expired');
        continue;
      }
      let s: Awaited<ReturnType<FundingPort['status']>>;
      try {
        s = await this.d.funding.status(row.depositAddress);
      } catch (e) {
        this.d.log.warn({ fundingId: row.id, err: (e as Error).name }, 'funding status failed');
        continue;
      }
      if (s.state === 'pending') {
        await this.d.repo.note(row.id, { lastCheckedAt: now });
        continue;
      }
      if (s.state === 'processing') {
        if (row.state !== 'processing') {
          await this.d.repo.note(row.id, { state: 'processing', lastCheckedAt: now });
          if (row.cardId) await this.setCard(row, 'ready', 'the dollars are on their way…');
        }
        continue;
      }
      if (s.state === 'success') {
        const claimed = await this.d.repo.claim(row.id, 'success', {
          lastCheckedAt: now,
          ...(s.amountOutDisplay ? { amountOutDisplay: s.amountOutDisplay } : {}),
        });
        if (!claimed) continue;
        await this.setCard(row, 'done', 'landed');
        await this.text(
          row,
          `your ${formatUsd(row.amountUsd)} landed. ${s.amountOutDisplay ?? 'it'} is in your penny account.`,
        );
        settled += 1;
        continue;
      }
      if (s.state === 'refunded') {
        const claimed = await this.d.repo.claim(row.id, 'refunded', { lastCheckedAt: now });
        if (!claimed) continue;
        await this.setCard(row, 'done', 'came back');
        await this.text(
          row,
          `the ${formatUsd(row.amountUsd)} came back as a refund. it's in your penny account.`,
        );
        settled += 1;
        continue;
      }
      if (s.state === 'failed') {
        const claimed = await this.d.repo.claim(row.id, 'failed', { lastCheckedAt: now });
        if (!claimed) continue;
        await this.setCard(row, 'failed', "didn't arrive");
        await this.text(row, `the ${formatUsd(row.amountUsd)} didn't arrive. nothing was taken.`);
        settled += 1;
      }
    }
    return settled;
  }

  private async setCard(
    row: FundingRow,
    state: 'ready' | 'done' | 'failed' | 'expired',
    statusLine?: string,
  ): Promise<void> {
    if (!row.cardId) return;
    try {
      await this.d.cards.update(
        row.cardId,
        { state },
        statusLine ? { subcaption: statusLine } : {},
      );
    } catch (e) {
      this.d.log.warn({ fundingId: row.id, err: (e as Error).name }, 'funding card update failed');
    }
  }

  private async text(row: FundingRow, text: string): Promise<void> {
    try {
      const space = await this.d.users.primarySpace(row.userId);
      if (!space) return;
      await this.d.messaging.sendText(space.space, text);
    } catch (e) {
      this.d.log.warn({ fundingId: row.id, err: (e as Error).name }, 'funding text failed');
    }
  }

  private clock(at: Date): string {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: this.d.timeZone,
    }).format(at);
  }
}
