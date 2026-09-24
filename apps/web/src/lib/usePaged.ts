import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "./api";

type Query = Record<string, string | number | boolean | null | undefined>;

/** A keyset-paginated API list: first page on mount, "Load more" for the rest. */
export function usePaged<T>(key: string, path: string, query: Query, options: { enabled?: boolean; pageSize?: number } = {}) {
  const q = useInfiniteQuery({
    queryKey: [key, path, query],
    enabled: options.enabled ?? true,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.get<{ data: T[]; nextCursor: string | null }>(path, { ...query, limit: options.pageSize ?? 50, cursor: pageParam }, signal),
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: (previous) => previous,
  });
  return {
    rows: q.data?.pages.flatMap((p) => p.data) ?? [],
    loading: q.isPending,
    error: q.error,
    hasMore: q.hasNextPage,
    loadingMore: q.isFetchingNextPage,
    loadMore: () => void q.fetchNextPage(),
    refetch: () => void q.refetch(),
  };
}
