import { schema } from "@vyapaar/db";
import { and, eq, isNull } from "drizzle-orm";
import type { AppDeps, RequestCtx } from "../lib/context.js";
import { withTenant } from "../lib/db.js";
import type { Letterhead } from "./pdf-report.js";

/** The firm's name, address, contact, GSTIN and logo, for the top of PDF documents. */
export async function loadLetterhead(deps: AppDeps, ctx: RequestCtx): Promise<Letterhead> {
  return withTenant(deps.db, ctx, async (tx) => {
    const [b] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, ctx.businessId));
    let logo: Buffer | null = null;
    if (b!.logoFileId) {
      const [f] = await tx
        .select({ mimeType: schema.files.mimeType, content: schema.files.content })
        .from(schema.files)
        .where(and(eq(schema.files.id, b!.logoFileId), isNull(schema.files.deletedAt)));
      // PDFKit reads PNG and JPEG.
      if (f?.content && (f.mimeType === "image/png" || f.mimeType === "image/jpeg")) logo = f.content;
    }
    return {
      name: b!.tradeName ?? b!.legalName,
      address: [[b!.addressLine1, b!.addressLine2].filter(Boolean).join(", "), [b!.city, b!.pincode].filter(Boolean).join(" ")].filter(Boolean),
      contact: [b!.phone, b!.email].filter(Boolean).join(" · ") || null,
      gstin: b!.gstin,
      logo,
    };
  });
}
