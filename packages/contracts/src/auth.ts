import { z } from "zod";
import { Gstin, Mobile, StateCode } from "./common.js";

export const OtpPurpose = z.enum(["signup", "login", "reset"]);

export const OtpRequestBody = z.strictObject({
  mobile: Mobile,
  purpose: OtpPurpose,
});

export const BusinessInput = z.strictObject({
  legalName: z.string().trim().min(2).max(200),
  tradeName: z.string().trim().max(200).optional(),
  gstin: Gstin.optional(),
  stateCode: StateCode,
  gstRegistration: z.enum(["regular", "composition", "unregistered"]).default("regular"),
  city: z.string().trim().max(100).optional(),
  addressLine1: z.string().trim().max(200).optional(),
  pincode: z.string().regex(/^[1-9][0-9]{5}$/).optional(),
});

/** SaaS self-service signup: one call creates the user, the business (tenant) and its defaults. */
export const SignupBody = z.strictObject({
  name: z.string().trim().min(2).max(100),
  mobile: Mobile,
  email: z.email().optional(),
  password: z.string().min(8).max(128),
  otp: z.string().regex(/^\d{6}$/),
  preferredLocale: z.enum(["en", "hi"]).default("en"),
  business: BusinessInput,
});

export const LoginBody = z.strictObject({
  /** Mobile number, email or user ID. */
  identifier: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(128),
  businessId: z.uuid().optional(),
});

export const OtpLoginBody = z.strictObject({
  mobile: Mobile,
  otp: z.string().regex(/^\d{6}$/),
  businessId: z.uuid().optional(),
});

export const ResetPasswordBody = z.strictObject({
  mobile: Mobile,
  otp: z.string().regex(/^\d{6}$/),
  password: z.string().min(8).max(128),
});

/** The signed-in person's own name and email (an empty email removes it). */
export const UpdateProfileBody = z.strictObject({
  name: z.string().trim().min(2).max(100).optional(),
  email: z.union([z.email(), z.literal("")]).optional(),
});

export const CheckPasswordBody = z.strictObject({
  password: z.string().min(1).max(128),
});

export const ChangePasswordBody = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

/** Native clients (Android/Windows) send the refresh token in the body; browsers use the cookie. */
export const RefreshBody = z.strictObject({ refreshToken: z.string().min(20).max(200).optional() }).nullish();

export interface OtpRequestResponse {
  sent: true;
  expiresIn: number;
  /** Development only (OTP_DEV_ECHO). */
  devCode?: string;
}

export const SwitchBusinessBody = z.strictObject({ businessId: z.uuid() });

export const CreateBusinessBody = BusinessInput;

export interface BusinessSummary {
  id: string;
  legalName: string;
  tradeName: string | null;
  gstin: string | null;
  stateCode: string;
  status: string;
  plan: string;
  trialEndsAt: string | null;
  role: string;
  isOwner: boolean;
}

export interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  user: { id: string; name: string; mobile: string; email: string | null; preferredLocale: string };
  business: BusinessSummary | null;
  businesses: BusinessSummary[];
  /** Only returned to native clients (header X-Client: native); browsers get an HttpOnly cookie. */
  refreshToken?: string;
}

export interface MeResponse {
  user: SessionResponse["user"];
  business:
    | (BusinessSummary & {
        financialYearStartMonth: number;
        timeZone: string;
        gstRegistration: string;
        addressLine1: string | null;
        addressLine2: string | null;
        city: string | null;
        pincode: string | null;
        phone: string | null;
        email: string | null;
        /** Changes whenever a new logo is uploaded (GET /business/logo). */
        logoFileId: string | null;
      })
    | null;
  permissions: string[];
  settings: Record<string, unknown>;
  today: string;
}
