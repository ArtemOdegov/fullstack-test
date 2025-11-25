export type TaskFactory<T> = () => Promise<T>;

type Deferred<T> = {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export class DeduplicatedTaskQueue<T> {
  private timer: ReturnType<typeof setTimeout> | null;
  private readonly pending: Map<string, { task: TaskFactory<T>; deferred: Deferred<T>; promise: Promise<T> }>;
  private readonly intervalMs: number;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
    this.timer = null;
    this.pending = new Map();
  }

  enqueue(key: string, task: TaskFactory<T>): Promise<T> {
    if (this.pending.has(key)) {
      return this.pending.get(key)!.promise;
    }

    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.pending.set(key, { task, deferred: { resolve, reject }, promise });
    this.ensureTimer();

    return promise;
  }

  private ensureTimer() {
    if (this.timer) {
      return;
    }

    this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }

  private async flush() {
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    this.timer = null;

    await Promise.all(
      entries.map(async ({ task, deferred }) => {
        try {
          const result = await task();
          deferred.resolve(result);
        } catch (error) {
          deferred.reject(error);
        }
      })
    );
  }
}

export class ValueAccumulatorQueue<T> {
  private timer: ReturnType<typeof setTimeout> | null;
  private readonly values: Map<string, T>;
  private readonly waiters: Deferred<unknown>[];
  private readonly intervalMs: number;
  private readonly sender: (values: T[]) => Promise<unknown>;
  private readonly keyFn: (value: T) => string;

  constructor(
    intervalMs: number,
    sender: (values: T[]) => Promise<unknown>,
    keyFn: (value: T) => string = (value) => JSON.stringify(value)
  ) {
    this.intervalMs = intervalMs;
    this.sender = sender;
    this.keyFn = keyFn;
    this.timer = null;
    this.values = new Map();
    this.waiters = [];
  }

  add(value: T): Promise<unknown> {
    return this.addMany([value]);
  }

  addMany(valueList: T[]): Promise<unknown> {
    valueList.forEach((value) => {
      this.values.set(this.keyFn(value), value);
    });

    let resolve!: (value: unknown) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.waiters.push({ resolve, reject });

    this.ensureTimer();
    return promise;
  }

  private ensureTimer() {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }

  private async flush() {
    if (!this.values.size) {
      this.resolveWaiters(undefined);
      this.timer = null;
      return;
    }

    const payload = Array.from(this.values.values());
    this.values.clear();
    this.timer = null;

    try {
      const result = await this.sender(payload);
      this.resolveWaiters(result);
    } catch (error) {
      this.rejectWaiters(error);
    }
  }

  private resolveWaiters(value: unknown) {
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      waiter?.resolve(value);
    }
  }

  private rejectWaiters(error: unknown) {
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      waiter?.reject(error);
    }
  }
}

export class LatestValueQueue<T> {
  private timer: ReturnType<typeof setTimeout> | null;
  private latest: T | null;
  private readonly waiters: Deferred<unknown>[];
  private readonly intervalMs: number;
  private readonly sender: (value: T) => Promise<unknown>;

  constructor(intervalMs: number, sender: (value: T) => Promise<unknown>) {
    this.intervalMs = intervalMs;
    this.sender = sender;
    this.timer = null;
    this.latest = null;
    this.waiters = [];
  }

  set(value: T): Promise<unknown> {
    this.latest = value;

    let resolve!: (value: unknown) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.waiters.push({ resolve, reject });
    this.ensureTimer();
    return promise;
  }

  private ensureTimer() {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }

  private async flush() {
    if (this.latest == null) {
      this.resolveWaiters(undefined);
      this.timer = null;
      return;
    }

    const payload = this.latest;
    this.latest = null;
    this.timer = null;

    try {
      const result = await this.sender(payload);
      this.resolveWaiters(result);
    } catch (error) {
      this.rejectWaiters(error);
    }
  }

  private resolveWaiters(value: unknown) {
    while (this.waiters.length) {
      this.waiters.shift()?.resolve(value);
    }
  }

  private rejectWaiters(error: unknown) {
    while (this.waiters.length) {
      this.waiters.shift()?.reject(error);
    }
  }
}
