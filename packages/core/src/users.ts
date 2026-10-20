import { z } from 'zod';

export const verifiedIdentitySchema = z
  .object({
    subject: z.string().min(1).max(500),
    externalUserId: z.string().min(1).max(200),
    provider: z.literal('descope'),
    email: z.string().trim().toLowerCase().email().max(320),
    emailVerified: z.literal(true),
    name: z.string().trim().max(200).nullable().default(null),
    lastName: z.string().trim().max(200).nullable().default(null),
  })
  .strict();
export type VerifiedIdentity = z.infer<typeof verifiedIdentitySchema>;
export interface User {
  id: string;
  subject: string;
  descopeUserId: string;
  email: string;
  name: string | null;
  lastName: string | null;
  isSystemAdmin: boolean;
  disabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
}
export interface UserAccount {
  projectId: string;
  projectName: string;
  role: 'owner' | 'viewer';
}
export const userAccessSchema = z
  .object({
    version: z.number().int().positive(),
    isSystemAdmin: z.boolean().optional(),
    disabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => v.isSystemAdmin !== undefined || v.disabled !== undefined,
    'Supply an access change',
  );
export const assignmentSchema = z
  .object({
    version: z.number().int().positive(),
    role: z.enum(['owner', 'viewer']),
  })
  .strict();
