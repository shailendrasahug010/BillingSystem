import { useQuery } from "@tanstack/react-query";
import { LIVE } from "../data/source";
import { api } from "./api";

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True when this page is open at the computer's own address, which other devices cannot use. */
export const isLocalAddress = () => LOCAL.has(location.hostname);

/**
 * The address other people's phones open Digital Bahi at: this page's own
 * address on a server (https://billing.yourshop.in) or a phone already on the
 * Wi-Fi; at localhost, the computer's Wi-Fi address when it was started for
 * phones too ("Start Digital Bahi"). null: phones cannot reach it from here.
 */
export function useAppLink(): { link: string | null; local: boolean; loading: boolean } {
  const local = isLocalAddress();
  const q = useQuery({
    queryKey: ["phone-address"],
    queryFn: () => api.get<{ urls: string[] }>("/phone-address"),
    enabled: LIVE && local,
    staleTime: 60_000,
  });
  if (!local) return { link: location.origin, local, loading: false };
  return { link: q.data?.urls[0] ?? null, local, loading: q.isPending && LIVE };
}
