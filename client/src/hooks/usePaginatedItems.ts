import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PagedResponse } from '../api/client';

type Loader = (params: { search?: string; offset?: number }) => Promise<PagedResponse>;

type ListState = {
  items: number[];
  search: string;
  hasMore: boolean;
  error: string | null;
  isInitialLoading: boolean;
  isAppending: boolean;
  refresh: () => void;
  setSearch: (next: string) => void;
  loadMore: () => Promise<void>;
  initialized: boolean;
  updateItems: (updater: (prev: number[]) => number[]) => void;
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message || 'Неизвестная ошибка';
  }
  return 'Неизвестная ошибка';
};

export const usePaginatedItems = (loader: Loader): ListState => {
  const [items, setItems] = useState<number[]>([]);
  const [search, setSearch] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [status, setStatusState] = useState<'idle' | 'initial' | 'append'>('idle');
  const [initialized, setInitialized] = useState(false);
  const statusRef = useRef<'idle' | 'initial' | 'append'>(status);
  const setStatus = useCallback((next: 'idle' | 'initial' | 'append') => {
    statusRef.current = next;
    setStatusState(next);
  }, []);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  const triggerRefresh = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    let active = true;
    setStatus('initial');
    setInitialized(false);
    setItems([]);
    setHasMore(true);
    setError(null);

    const fetchInitial = async () => {
      try {
        const page = await loader({ search, offset: 0 });
        if (!active) {
          return;
        }
        setItems(page.items);
        setHasMore(page.hasMore);
        setInitialized(true);
      } catch (err) {
        if (!active) {
          return;
        }
        setError(getErrorMessage(err));
      } finally {
        if (active) {
          setStatus('idle');
        }
      }
    };

    fetchInitial();
    return () => {
      active = false;
    };
  }, [loader, refreshKey, search, setStatus]);

  const loadMore = useCallback(async () => {
    if (!hasMore || statusRef.current !== 'idle') {
      return;
    }
    setStatus('append');
    setError(null);
    try {
      const page = await loader({ search, offset: itemsRef.current.length });
      setItems((prev) => [...prev, ...page.items]);
      setHasMore(page.hasMore);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setStatus('idle');
    }
  }, [hasMore, loader, search, setStatus]);

  const updateItems = useCallback((updater: (prev: number[]) => number[]) => {
    setItems((prev) => updater(prev));
  }, []);

  return useMemo(
    () => ({
      items,
      search,
      hasMore,
      error,
      isInitialLoading: status === 'initial' && !initialized,
      isAppending: status === 'append',
      refresh: triggerRefresh,
      setSearch,
      loadMore,
      initialized,
      updateItems,
    }),
    [error, hasMore, initialized, items, loadMore, search, status, triggerRefresh, updateItems]
  );
};

