import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core';

/**
 * Embedding width. ARCHITECTURE.md says vector(1536). NEAR AI Cloud's
 * Qwen/Qwen3-Embedding-0.6B returns 1024 dims; the embedder zero-pads to 1536
 * (cosine-preserving). PROPOSED: change the contract to 1024.
 */
export const EMBEDDING_DIM = 1536;

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    handle: text('handle').notNull(), // iMessage handle (E.164 or email)
    slug: text('slug'), // <slug>.penny.near
    accountId: text('account_id'),
    /** The account this user enrolled was only simulated (DRY_RUN=1). Replayed on enroll retries. */
    enrolledDryRun: boolean('enrolled_dry_run').notNull().default(false),
    /** Set by "freeze": every approval fails until the user texts "unfreeze". */
    frozenAt: ts('frozen_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_handle_uq').on(t.handle), uniqueIndex('users_slug_uq').on(t.slug)],
);

export const devices = pgTable(
  'devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    publicKey: text('public_key').notNull(), // base64url raw ed25519
    /** ios_app (key in the iPhone Keychain, has the iMessage extension) or web_passkey. */
    platform: text('platform', { enum: ['ios_app', 'web_passkey'] })
      .notNull()
      .default('ios_app'),
    /** The iMessage extension is installed: live cards can be sent. */
    hasExtension: boolean('has_extension').notNull().default(true),
    appAttest: text('app_attest'),
    /** Verified App Attest credential (set only after full verification). */
    appAttestKeyId: text('app_attest_key_id'),
    appAttestPublicKey: text('app_attest_public_key'), // base64url x||y
    appAttestCounter: integer('app_attest_counter').notNull().default(0),
    appAttestVerified: boolean('app_attest_verified').notNull().default(false),
    enrolledAt: ts('enrolled_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
    /** Why it was revoked: 'user' (device screen) or 'freeze' (unfreeze restores these). */
    revokedReason: text('revoked_reason'),
  },
  (t) => [index('devices_user_idx').on(t.userId), uniqueIndex('devices_pk_uq').on(t.publicKey)],
);

export const enrollCodes = pgTable('enroll_codes', {
  codeHash: text('code_hash').primaryKey(), // sha256 hex of the 8-char code
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  handle: text('handle').notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: createdAt(),
});

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    spaceId: text('space_id').notNull(),
    platform: text('platform').notNull(),
    /** Penny line the user texts (Spectrum space phone), so proactive texts go out on it. */
    phone: text('phone'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('conversations_space_uq').on(t.spaceId),
    index('conversations_user_idx').on(t.userId, t.createdAt),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    direction: text('direction', { enum: ['inbound', 'outbound'] }).notNull(),
    botId: text('bot_id'),
    externalId: text('external_id'),
    text: text('text').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('messages_conv_idx').on(t.conversationId, t.createdAt)],
);

export const bots = pgTable(
  'bots',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id), // null = built-in
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    soulMd: text('soul_md').notNull(),
    mood: text('mood').notNull().default('idle'),
    toolIds: text('tool_ids').array().notNull().default(sql`'{}'::text[]`),
    permissions: jsonb('permissions')
      .$type<{ canMoveMoney: boolean; perTxCap?: string; dailyCap?: string }>()
      .notNull()
      .default({ canMoveMoney: false }),
    nearSubAccount: text('near_sub_account'),
    status: text('status', {
      enum: ['draft', 'pending_confirm', 'pending_approval', 'active', 'paused', 'archived'],
    })
      .notNull()
      .default('draft'),
    builtIn: boolean('built_in').notNull().default(false),
    approvalId: text('approval_id'),
    createdAt: createdAt(),
  },
  (t) => [
    // one slug per owner; built-ins share the null owner
    uniqueIndex('bots_owner_slug_uq').on(sql`coalesce(${t.userId}, '')`, t.slug),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    botId: text('bot_id'),
    kind: text('kind', {
      enum: ['invest', 'send', 'pay_bill', 'errand', 'create_bot', 'write'],
    }).notNull(),
    plan: jsonb('plan').notNull(),
    /** The bill a pay_bill card pays. A live-card partial unique index claims it. */
    billId: text('bill_id'),
    title: text('title').notNull(),
    amountDisplay: text('amount_display').notNull(),
    amountMicros: bigint('amount_micros', { mode: 'bigint' }).notNull().default(sql`0`),
    facts: jsonb('facts').$type<{ label: string; value: string }[]>().notNull(),
    signerId: text('signer_id').notNull(),
    receiverId: text('receiver_id').notNull(),
    actions: jsonb('actions').notNull(),
    nonce: text('nonce').notNull(),
    maxBlockHeight: text('max_block_height').notNull(),
    expiresAt: ts('expires_at').notNull(),
    status: text('status', {
      enum: ['pending', 'signed', 'relayed', 'settled', 'failed', 'expired', 'cancelled'],
    }).notNull(),
    planHash: text('plan_hash').notNull(),
    cardTokenHash: text('card_token_hash').notNull(),
    /**
     * Live-card handle, so a card can still be edited after a restart. The in-process
     * map alone meant every redeploy froze in-flight cards at their last state.
     */
    cardRef: text('card_ref'),
    /** Space the card was sent to, needed to re-send or re-edit it. */
    cardSpace: jsonb('card_space').$type<{
      spaceId: string;
      userHandle: string;
      phone?: string;
      baseUrl?: string;
    }>(),
    /** sha256 over the canonical action + id + expiresAt + planHash (@penny/shared approvalHash). */
    approvalHash: text('approval_hash'),
    /** 32 random bytes, base64url. Burned on the first sign or passkey attempt. */
    challenge: text('challenge'),
    challengeUsedAt: ts('challenge_used_at'),
    /** The approval this one replaced (expired, failed check, or "get a new card"). */
    reissuedFrom: text('reissued_from'),
    cardId: text('card_id'),
    txHash: text('tx_hash'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('approvals_user_idx').on(t.userId, t.createdAt),
    index('approvals_card_token_idx').on(t.cardTokenHash),
    // one replacement per approval: concurrent renews can't double-reserve the limit
    uniqueIndex('approvals_reissued_from_uq')
      .on(t.reissuedFrom)
      .where(sql`${t.reissuedFrom} is not null`),
    // one live card per bill: the database, not a read-then-write scan, is the
    // guarantee a bill cannot be paid twice by two concurrent crew turns.
    uniqueIndex('approvals_bill_live_uq')
      .on(t.userId, t.billId)
      .where(sql`${t.billId} is not null and ${t.status} in ('pending', 'signed', 'relayed')`),
  ],
);

/** Web passkeys (no-install path). Verified on the server for every approval. */
export const passkeys = pgTable(
  'passkeys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id),
    credentialId: text('credential_id').notNull(), // base64url
    publicKey: text('public_key').notNull(), // base64url COSE key
    signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
    transports: text('transports').array().notNull().default(sql`'{}'::text[]`),
    platform: text('platform').notNull().default('web_passkey'),
    createdAt: createdAt(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    uniqueIndex('passkeys_credential_uq').on(t.credentialId),
    index('passkeys_user_idx').on(t.userId),
  ],
);

/** Every card Penny sends (docs/DESIGN.md section 4): info or approval, live or link. */
export const cards = pgTable(
  'cards',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    agent: text('agent').notNull(),
    kind: text('kind', { enum: ['info', 'approval'] }).notNull(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    amount: text('amount'),
    lines: jsonb('lines').$type<{ label?: string; value: string }[]>().notNull(),
    buttons: jsonb('buttons')
      .$type<{ id: string; label: string; action: string; value?: string }[]>()
      .notNull(),
    state: text('state').notNull(),
    approvalId: text('approval_id'),
    /** sha256 hex of the card token (the token itself is never stored). */
    tokenHash: text('token_hash').notNull(),
    tokenExpiresAt: ts('token_expires_at').notNull(),
    /** Server-only data behind the buttons (reminder id, email draft). Never sent to clients. */
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    /** live = iMessage extension card, link = picture link card. */
    channel: text('channel', { enum: ['live', 'link'] }).notNull(),
    /** Live card message handle, so the card can still be edited after a restart. */
    messageRef: text('message_ref'),
    space: jsonb('space').$type<{ spaceId: string; phone?: string; userHandle: string }>(),
    receiptUrl: text('receipt_url'),
    /** One line on what happened, as the server knows it. */
    statusLine: text('status_line'),
    expiresAt: ts('expires_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cards_token_uq').on(t.tokenHash),
    index('cards_user_idx').on(t.userId, t.createdAt),
    index('cards_approval_idx').on(t.approvalId),
  ],
);

export const reminders = pgTable(
  'reminders',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    cardId: text('card_id'),
    text: text('text').notNull(),
    dueAt: ts('due_at').notNull(),
    space: jsonb('space')
      .$type<{ spaceId: string; phone?: string; userHandle: string }>()
      .notNull(),
    /** user = asked for ("remind me…"); bill = the day before a saved bill is due. */
    source: text('source', { enum: ['user', 'bill'] })
      .notNull()
      .default('user'),
    /** The bill a bill reminder is for (one reminder per bill). */
    billId: text('bill_id'),
    /** Failed send attempts. Retries while below the cap, then stops. */
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    status: text('status', { enum: ['scheduled', 'sent', 'undone', 'failed'] })
      .notNull()
      .default('scheduled'),
    createdAt: createdAt(),
  },
  (t) => [
    index('reminders_due_idx').on(t.status, t.dueAt),
    index('reminders_user_idx').on(t.userId, t.status),
    uniqueIndex('reminders_bill_uq').on(t.billId),
  ],
);

export const approvalEvents = pgTable(
  'approval_events',
  {
    id: text('id').primaryKey(),
    /** Monotonic insertion order: created_at ties at millisecond precision. */
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    approvalId: text('approval_id')
      .notNull()
      .references(() => approvals.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    reason: text('reason'),
    meta: jsonb('meta'),
    createdAt: createdAt(),
  },
  // events() reads one approval's history in seq order; the old
  // (approval_id, created_at) index cannot serve that sort (ties are random).
  (t) => [index('approval_events_apr_seq_idx').on(t.approvalId, t.seq)],
);

export const guardPolicies = pgTable('guard_policies', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id),
  perTxUsd: text('per_tx_usd').notNull().default('50'),
  dailyUsd: text('daily_usd').notNull().default('100'),
  allowlist: text('allowlist').array().notNull().default(sql`'{}'::text[]`),
  blockNewRecipientsOverUsd: text('block_new_recipients_over_usd').notNull().default('20'),
  maxApprovalsPer10Min: integer('max_approvals_per_10_min').notNull().default(5),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const guardDecisions = pgTable(
  'guard_decisions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    approvalId: text('approval_id'),
    plan: jsonb('plan').notNull(),
    decision: text('decision', {
      enum: ['allow_with_approval', 'block', 'needs_more_info'],
    }).notNull(),
    reasons: jsonb('reasons').$type<string[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('guard_decisions_user_idx').on(t.userId, t.createdAt)],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    approvalId: text('approval_id').references(() => approvals.id),
    botId: text('bot_id'),
    asset: text('asset').notNull(),
    amountMicrosUsd: bigint('amount_micros_usd', { mode: 'bigint' }).notNull(),
    recipient: text('recipient'),
    status: text('status', { enum: ['reserved', 'settled', 'released'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ledger_user_idx').on(t.userId, t.createdAt)],
);

export const memories = pgTable(
  'memories',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    createdAt: createdAt(),
  },
  (t) => [index('memories_user_idx').on(t.userId)],
);

export const moods = pgTable(
  'moods',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    botSlug: text('bot_slug').notNull().default('penny'),
    mood: text('mood', {
      enum: ['idle', 'thinking', 'win', 'wink', 'blocked', 'paused', 'done'],
    }).notNull(),
    reason: text('reason'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.botSlug] })],
);

export const soulsChangelog = pgTable('souls_changelog', {
  id: text('id').primaryKey(),
  botId: text('bot_id').notNull(),
  userId: text('user_id'),
  diff: text('diff').notNull(),
  reason: text('reason'),
  createdAt: createdAt(),
});

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').notNull(),
    scope: text('scope').notNull(), // route + subject (approval id / ip)
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] })],
);

export const webhookEvents = pgTable('webhook_events', {
  id: text('id').primaryKey(), // `${webhookId}:${message.id}`
  event: text('event').notNull(),
  receivedAt: ts('received_at').notNull().defaultNow(),
  processedAt: ts('processed_at'),
  error: text('error'),
});

export const attestChallenges = pgTable('attest_challenges', {
  id: text('id').primaryKey(),
  /** app_attest or passkey (web enrollment). A challenge only works for its purpose. */
  purpose: text('purpose').notNull().default('app_attest'),
  codeHash: text('code_hash').notNull(),
  challenge: text('challenge').notNull(), // base64url raw bytes
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: createdAt(),
});

/**
 * Bills Mail found in the user's inbox. One row per source email (deduped by
 * source_key). Amount and due date are parsed deterministically from the email,
 * never by the model. biller_id points at the fixed registry in bills/billers.ts.
 */
export const bills = pgTable(
  'bills',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    sourceKey: text('source_key').notNull(), // gmail message id, or a hash of sender|subject|date
    billerId: text('biller_id'),
    payeeName: text('payee_name').notNull(),
    subject: text('subject').notNull(),
    amount: text('amount'), // decimal string, e.g. "18400" or "12.50"
    currency: text('currency', { enum: ['NGN', 'USD'] }),
    dueOn: text('due_on'), // YYYY-MM-DD
    receivedAt: ts('received_at'),
    status: text('status', { enum: ['open', 'paid', 'dismissed'] })
      .notNull()
      .default('open'),
    notifiedAt: ts('notified_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('bills_user_source_uq').on(t.userId, t.sourceKey),
    index('bills_user_status_idx').on(t.userId, t.status),
  ],
);

/**
 * A connect link Penny sent (gmail, github). The scheduler polls until the app is
 * connected or the watch expires, then tells the user and kicks off the first job.
 */
export const connectWatches = pgTable(
  'connect_watches',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    toolkit: text('toolkit').notNull(),
    /** The card that carried the link, so its state can change when the app connects. */
    cardId: text('card_id'),
    status: text('status', { enum: ['waiting', 'connected', 'expired'] })
      .notNull()
      .default('waiting'),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.toolkit] }),
    index('connect_watches_status_idx').on(t.status, t.expiresAt),
  ],
);

export const schema = {
  users,
  devices,
  enrollCodes,
  attestChallenges,
  conversations,
  messages,
  bots,
  approvals,
  approvalEvents,
  passkeys,
  cards,
  reminders,
  guardPolicies,
  guardDecisions,
  ledgerEntries,
  memories,
  moods,
  soulsChangelog,
  idempotencyKeys,
  webhookEvents,
  bills,
  connectWatches,
};
