// Remembers the result of an async loader in this process for `ttlMs`.
// Concurrent callers share one load, and a failed load is not remembered.
export function ttlCached(load, ttlMs, now = Date.now) {
  let value;
  let expires = 0;
  let pending = null;
  return () => {
    if (now() < expires) return Promise.resolve(value);
    pending ??= load()
      .then((result) => {
        value = result;
        expires = now() + ttlMs;
        return result;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}
