import { DeduplicatedTaskQueue, ValueAccumulatorQueue } from './queues';

export type PagedResponse = {
  items: number[];
  hasMore: boolean;
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';
const LIMIT = 20;

const request = async <T>(path: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || 'API error');
  }

  return response.json();
};

const buildQuery = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === '') {
      return;
    }
    search.append(key, String(value));
  });
  const query = search.toString();
  return query ? `?${query}` : '';
};

const unselectedQueue = new DeduplicatedTaskQueue<PagedResponse>(1000);
const selectedQueue = new DeduplicatedTaskQueue<PagedResponse>(1000);
const addQueue = new ValueAccumulatorQueue<number>(10000, (ids) =>
  request('/api/items/add', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
);
const selectQueue = new ValueAccumulatorQueue<number>(1000, (ids) =>
  request('/api/items/select', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
);
const unselectQueue = new ValueAccumulatorQueue<number>(1000, (ids) =>
  request('/api/items/unselect', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
);
const reorderQueue = new DeduplicatedTaskQueue<unknown>(1000);
let reorderCounter = 0;

export const api = {
  limit: LIMIT,
  loadUnselected(params: { search?: string; offset?: number }) {
    const query = buildQuery({ ...params, limit: LIMIT });
    const key = `unselected:${query}`;
    return unselectedQueue.enqueue(key, () => request<PagedResponse>(`/api/items/unselected${query}`));
  },
  loadSelected(params: { search?: string; offset?: number }) {
    const query = buildQuery({ ...params, limit: LIMIT });
    const key = `selected:${query}`;
    return selectedQueue.enqueue(key, () => request<PagedResponse>(`/api/items/selected${query}`));
  },
  addIds(ids: number[]) {
    return addQueue.addMany(ids);
  },
  select(ids: number[]) {
    return selectQueue.addMany(ids);
  },
  unselect(ids: number[]) {
    return unselectQueue.addMany(ids);
  },
  reorder(params: { ids: number[]; offset: number; search?: string }) {
    reorderCounter += 1;
    const key = `reorder:${reorderCounter}`;
    const payload = {
      ids: params.ids,
      offset: params.offset,
      search: params.search ?? '',
    };
    return reorderQueue.enqueue(key, () =>
      request('/api/items/reorder', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    );
  },
};
