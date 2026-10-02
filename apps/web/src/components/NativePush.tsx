import { useEffect } from "react";
import { useI18n } from "../app/i18n";
import { useRouter } from "../app/router";
import { useSession } from "../app/session";
import { markRead, targetRoute } from "../features/notifications/notifications";
import { startPush } from "../platform/push";

/** In the Android app: push notifications for the business signed in to; a tapped one opens its record. */
export function NativePush() {
  const { me } = useSession();
  const { locale } = useI18n();
  const { navigate } = useRouter();
  const businessId = me?.business?.id ?? null;
  useEffect(() => {
    if (!businessId) return;
    void startPush(businessId, locale, (data) => {
      // A notification of another business only opens the app.
      if (data.businessId && data.businessId !== businessId) return;
      if (data.notificationId) void markRead(data.notificationId).catch(() => undefined);
      const route = targetRoute({ type: (data.type ?? "") as never, entityType: data.entityType ?? null, entityId: data.entityId ?? null });
      if (route) navigate(route);
    }).catch(() => undefined);
  }, [businessId, locale, navigate]);
  return null;
}
