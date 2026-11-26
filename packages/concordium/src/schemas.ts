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

/**
 * The same endpoint answers a badge with one verdict, but answers an owner
 * account with an array of that account's agents. Both shapes are real, so both
 * are parsed rather than treated as a malformed response.
 */
export const OwnerCheckResponseSchema = z
  .object({
    network: z.string().default('testnet'),
    account: z.string(),
    agent_count: z.number().optional(),
    summary: z
      .object({
        valid: z.number().default(0),
        invalid: z.number().default(0),
      })
      .loose()
      .optional(),
    agents: z.array(BadgeCheckResponseSchema).default([]),
  })
  .loose();

export type OwnerCheckResponse = z.infer<typeof OwnerCheckResponseSchema>;

export const AnyCheckResponseSchema = z.union([BadgeCheckResponseSchema, OwnerCheckResponseSchema]);
