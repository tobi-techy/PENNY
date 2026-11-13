import { z } from 'zod';

const IssueSchema = z
  .object({
    severity: z.string(),
    field: z.string(),
    message: z.string(),
  })
  .loose();

const OnChainSchema = z
  .object({
    owner_account: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    agent_uri: z.string().nullable().optional(),
    metadata_hash_hex: z.string().nullable().optional(),
  })
  .loose();

export const BadgeCheckResponseSchema = z
  .object({
    token_id: z.union([z.number(), z.string()]).nullable().optional(),
    token_address: z.string().nullable().optional(),
    agent_uri: z.string().nullable().optional(),
    http_status: z.number().nullable().optional(),
    card_sha256: z.string().nullable().optional(),
    on_chain: OnChainSchema.optional(),
    checks: z.record(z.string(), z.union([z.boolean(), z.string(), z.null()])).default({}),
    badge_valid: z.boolean(),
    issues: z.array(IssueSchema).default([]),
    network: z.string().default('testnet'),
  })
  .loose();

export type BadgeCheckResponse = z.infer<typeof BadgeCheckResponseSchema>;
