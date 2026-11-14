-- Sign-in protection rework. Lifts account locks set under the old policy (up
-- to ~26 hours long, triggered by 15 lifetime failures) and clears the failure
-- counts kept under it. From now on an account is locked only after
-- LOGIN_ACCOUNT_MAX_ATTEMPTS wrong passwords in a row, for LOGIN_LOCK_MINUTES;
-- other limits are per address and never count a correct password
-- (src/modules/auth/loginGuard.js).
UPDATE admin_users
   SET failed_attempts = 0, locked_until = NULL
 WHERE failed_attempts <> 0 OR locked_until IS NOT NULL;
