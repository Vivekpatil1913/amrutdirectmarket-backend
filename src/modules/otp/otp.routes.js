import { Router } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../../config/env.js";
import { asyncHandler, success } from "../../lib/errors.js";
import * as service from "./otp.service.js";

const router = Router();

const otpLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.isTest ? 1000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many verification attempts. Please try again later." } },
});

router.post("/send", otpLimit, asyncHandler(async (req, res) =>
  success(res, await service.send(req.body, { ip: req.ip }), 201)));

router.post("/verify", otpLimit, asyncHandler(async (req, res) =>
  success(res, await service.verify(req.body))));

export default router;
