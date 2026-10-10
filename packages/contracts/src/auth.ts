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

/** A code from the authenticator app (6 digits) or one of the recovery codes ("k7m2p-x9q4r"). */
const TwoStepCode = z.string().trim().min(6).max(24);

/** Turning two-step sign-in on: the first code from the app, which proves it was set up right. */
export const TwoStepEnableBody = z.strictObject({ code: z.string().trim().regex(/^\d{6}$/) });

/** New recovery codes (the old ones stop working). */
export const TwoStepCodeBody = z.strictObject({ code: TwoStepCode });

/** Turning two-step sign-in off takes the password and a code. */
export const TwoStepOffBody = z.strictObject({ password: z.string().min(1).max(128), code: TwoStepCode });

/** The second step of a sign-in: the token from the first step's answer (TWO_STEP_REQUIRED) and the code. */
export const TwoStepLoginBody = z.strictObject({ token: z.string().min(20).max(2000), code: TwoStepCode });

export interface TwoStepStatus {
  enabled: boolean;
  enabledAt: string | null;
  /** Recovery codes not used yet. */
  recoveryCodesLeft: number;
}

/** What the authenticator app is set up with: the secret (to type by hand) and the same as a QR code's text. */
export interface TwoStepSetup {
  secret: string;
  uri: string;
}

/** One sign-in on a phone, browser or computer that is still signed in. */
export interface SignedInSession {
  id: string;
  /** The session this request comes from. */
  current: boolean;
  /** The browser or app, as it describes itself. */
  userAgent: string | null;
  ip: string | null;
  signedInAt: string;
  /** Its last refresh (every few minutes while it is open). */
  lastSeenAt: string;
}

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
  /**
   * The business asks this person's role for two-step sign-in and they have not turned it on: until they
   * do, its screens stay closed (no permissions or settings come with this answer).
   */
  twoStepRequired?: boolean;
}
