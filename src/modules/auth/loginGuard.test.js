import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createLoginGuard, isInternalAddress } from "./loginGuard.js";
import { errorHandler } from "../../middleware/error.js";

// A stand-in login route: "right" is the correct password for every account.
async function startApp(limits) {
  const app = express();
  app.set("trust proxy", "loopback"); // lets each request pick its address via X-Forwarded-For
  app.use(express.json());
  const guard = createLoginGuard({ windowMinutes: 15, ...limits });
  app.post("/login", guard.middleware, async (req, res) => {
    if (req.body.password !== "right") return res.status(401).json({ error: { code: "UNAUTHENTICATED" } });
    await guard.succeeded(req);
    return res.json({ ok: true });
  });
  app.use(errorHandler);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const login = async (email, password, ip = "203.0.113.1") => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ email, password }),
    });
    return { status: res.status, body: await res.json(), retryAfter: res.headers.get("retry-after") };
  };
  return { login, close: () => server.close() };
}

test("successful sign-ins are never limited, however many and with however many accounts", async () => {
  const { login, close } = await startApp({ maxPerAccount: 3, maxPerAddress: 5 });
  try {
    for (let i = 0; i < 40; i += 1) {
      assert.equal((await login(`user${i % 4}@x.in`, "right")).status, 200, `sign-in ${i + 1}`);
    }
  } finally {
    close();
  }
});

test("wrong passwords pause only that account, only from that address", async () => {
  const { login, close } = await startApp({ maxPerAccount: 3, maxPerAddress: 100 });
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await login("a@x.in", "wrong")).status, 401);

    const paused = await login("a@x.in", "right");
    assert.equal(paused.status, 429, "even the right password waits once the pause starts");
    assert.equal(paused.body.error.code, "RATE_LIMITED");
    assert.match(paused.body.error.message, /Try again in \d+ minute/);
    assert.ok(Number(paused.retryAfter) > 0);

    assert.equal((await login("b@x.in", "right")).status, 200, "other accounts from the same office");
    assert.equal((await login("A@X.in ", "right", "198.51.100.7")).status, 200, "the same account elsewhere");
  } finally {
    close();
  }
});

test("a correct password forgets earlier typos for that account", async () => {
  const { login, close } = await startApp({ maxPerAccount: 3, maxPerAddress: 100 });
  try {
    for (let round = 0; round < 3; round += 1) {
      assert.equal((await login("c@x.in", "wrong")).status, 401);
      assert.equal((await login("c@x.in", "wrong")).status, 401);
      assert.equal((await login("c@x.in", "right")).status, 200, `round ${round + 1}`);
    }
  } finally {
    close();
  }
});

test("one address guessing across many accounts is stopped; other addresses are not", async () => {
  const { login, close } = await startApp({ maxPerAccount: 10, maxPerAddress: 5 });
  try {
    for (let i = 0; i < 5; i += 1) assert.equal((await login(`spray${i}@x.in`, "wrong", "192.0.2.9")).status, 401);
    const blocked = await login("fresh@x.in", "right", "192.0.2.9");
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error.message, /from this network/);
    assert.equal((await login("fresh@x.in", "right", "192.0.2.10")).status, 200);
  } finally {
    close();
  }
});

test("internal addresses are recognised (a sign of a proxy hiding the client)", () => {
  for (const ip of ["127.0.0.1", "10.0.139.9", "172.31.5.2", "192.168.1.4", "::1", "::ffff:10.1.2.3", "fd00::1"]) {
    assert.ok(isInternalAddress(ip), ip);
  }
  for (const ip of ["203.0.113.1", "49.36.12.8", "2405:201:1::1", "", undefined, "garbage"]) {
    assert.ok(!isInternalAddress(ip), String(ip));
  }
});
