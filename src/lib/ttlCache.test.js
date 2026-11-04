import test from "node:test";
import assert from "node:assert/strict";
import { ttlCached } from "./ttlCache.js";

test("ttlCached: reuses a value until the TTL passes", async () => {
  let time = 0;
  let loads = 0;
  const get = ttlCached(async () => ++loads, 300_000, () => time);
  assert.equal(await get(), 1);
  time = 299_999;
  assert.equal(await get(), 1);
  time = 300_000;
  assert.equal(await get(), 2);
});

test("ttlCached: concurrent callers share one load", async () => {
  let loads = 0;
  const get = ttlCached(async () => ++loads, 1000);
  assert.deepEqual(await Promise.all([get(), get(), get()]), [1, 1, 1]);
});

test("ttlCached: a failed load is retried, not remembered", async () => {
  let fail = true;
  const get = ttlCached(async () => {
    if (fail) throw new Error("down");
    return "ok";
  }, 1000);
  await assert.rejects(get(), /down/);
  fail = false;
  assert.equal(await get(), "ok");
});
