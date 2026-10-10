import { z } from "zod";
import { Id, Mobile } from "./common.js";

/** A user ID to sign in with: starts with a letter, then letters, digits, ".", "_" or "-" (3-30, kept in lower case). */
export const Username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9._-]{2,29}$/);

export const InviteMemberBody = z.strictObject({
  name: z.string().trim().min(2).max(100),
  mobile: Mobile,
  email: z.email().optional(),
  roleId: Id,
  /** For a new account: a user ID and password to sign in with at once. An existing account keeps its own. */
  username: Username.optional(),
  password: z.string().min(8).max(128).optional(),
});

/** Sets a staff member's user ID and / or password (only for accounts used in this business alone). */
export const MemberCredentialsBody = z
  .strictObject({
    username: Username.nullable().optional(),
    password: z.string().min(8).max(128).optional(),
    /** Turns off the member's two-step sign-in (a lost phone and lost recovery codes); they can turn it on again. */
    twoStepOff: z.literal(true).optional(),
  })
  .refine((b) => b.username !== undefined || b.password !== undefined || b.twoStepOff !== undefined, { message: "Nothing to change" });

export const UpdateMemberBody = z.strictObject({
  roleId: Id.optional(),
  isActive: z.boolean().optional(),
});

const Grant = z.string().regex(/^(\*|[a-z_]+\.(\*|[a-z_]+))$/);

export const RoleBody = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  name: z.string().trim().min(2).max(60),
  nameHi: z.string().trim().max(60).optional(),
  description: z.string().trim().max(300).optional(),
  grants: z.array(Grant).max(200),
});

export const UpdateRoleBody = z.strictObject({
  name: z.string().trim().min(2).max(60).optional(),
  nameHi: z.string().trim().max(60).optional(),
  description: z.string().trim().max(300).optional(),
});

export const AuditLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
  entityType: z.string().max(40).optional(),
  entityId: Id.optional(),
  userId: Id.optional(),
  action: z.string().max(60).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export const RolePermissionsBody = z.strictObject({ grants: z.array(Grant).max(200) });
