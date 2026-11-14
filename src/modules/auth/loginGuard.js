import net from "net";
import rateLimit from "express-rate-limit";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

// Brute-force protection for POST /auth/login that never gets in the way of a
// correct password:
//
//  - Only failed sign-ins (401) are counted. Successful ones are not, so
//    anyone can sign in as often as they like, with as many accounts as they
//    like, from one office connection or many.
//  - byAccount: wrong passwords for one account from one address. Pausing it
//    stops guessing from that address without touching the real user
//    elsewhere or the other accounts used from the same office.
//  - byAddress: wrong passwords from one address across every account (a
//    high cap, against one host spraying many accounts).
//  - A correct password clears that account's count for that address.
//
// The account-wide backstop (guessing spread over many addresses) is kept in
// the database by the login route, because admins see it as "Locked".

const minutesUntil = (date) => Math.max(1, Math.ceil((date.getTime() - Date.now()) / 60000));
const emailOf = (req) => String(req.body?.email ?? "").trim().toLowerCase().slice(0, 255);
const accountKey = (req) => `${req.ip}|${emailOf(req)}`;

function failureLimit({ windowMinutes, max, key, message }) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: key,
    skipSuccessfulRequests: true,
    // Only a rejected email/password counts; a refused (429/423) or failed
    // (5xx) request was never a guess.
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    handler: (req, _res, next) => next(new AppError("RATE_LIMITED", message(minutesUntil(req.rateLimit.resetTime)), 429)),
  });
}

export function createLoginGuard({ windowMinutes, maxPerAccount, maxPerAddress, warnOnProxyAddress = false }) {
  const byAddress = failureLimit({
    windowMinutes,
    max: maxPerAddress,
    key: (req) => req.ip,
    message: (m) => `Too many failed sign-in attempts from this network. Try again in ${m} minute(s).`,
  });
  const byAccount = failureLimit({
    windowMinutes,
    max: maxPerAccount,
    key: accountKey,
    message: (m) => `Too many incorrect passwords for this account. Try again in ${m} minute(s), or ask a super admin to reset the password.`,
  });

  const middleware = [byAddress, byAccount];
  if (warnOnProxyAddress) middleware.unshift(warnIfProxyAddress());

  return {
    middleware,
    // Call after a correct password so earlier typos from here are forgotten.
    succeeded: (req) => byAccount.resetKey(accountKey(req)),
  };
}

const INTERNAL = new net.BlockList();
for (const [subnet, bits] of [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["169.254.0.0", 16]]) {
  INTERNAL.addSubnet(subnet, bits, "ipv4");
}
INTERNAL.addAddress("::1", "ipv6");
INTERNAL.addSubnet("fc00::", 7, "ipv6");
INTERNAL.addSubnet("fe80::", 10, "ipv6");

export function isInternalAddress(ip) {
  const family = net.isIP(ip ?? "");
  return family !== 0 && INTERNAL.check(ip, family === 6 ? "ipv6" : "ipv4");
}

// Sign-ins come from browsers on the internet. If one appears to come from a
// private address, the proxy in front (nginx, a load balancer) is not passing
// the visitor's address on, every visitor shares one set of limits, and one
// person's typos can block everyone. Logged once per process.
function warnIfProxyAddress() {
  let warned = false;
  return (req, _res, next) => {
    if (!warned && isInternalAddress(req.ip)) {
      warned = true;
      logger.warn(
        `Sign-in request seen from internal address ${req.ip}: the proxy is not forwarding the client address, ` +
          "so all visitors share one rate limit. In nginx set `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` " +
          "for /api, and set TRUST_PROXY if another proxy (e.g. CloudFront) sits in front."
      );
    }
    next();
  };
}
