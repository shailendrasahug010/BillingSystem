import { z } from "zod";
import { Id, Mobile } from "./common.js";

export const InviteMemberBody = z.strictObject({
  name: z.string().trim().min(2).max(100),
  mobile: Mobile,
  email: z.email().optional(),
  roleId: Id,
});

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
