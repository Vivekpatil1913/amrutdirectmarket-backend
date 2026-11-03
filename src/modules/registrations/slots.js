import { SLOT_HOLDING_STATUSES } from "../../lib/constants.js";

// Stall slot accounting. Every function takes the transaction's db helpers:
// the quota row is locked by the first UPDATE / SELECT … FOR UPDATE and held
// until commit, so concurrent registrations for the same quota serialise and
// `available` can never go below zero or drift from the real allocations.

// Takes one slot; returns the remaining count, or null when none is free.
export async function takeSlot(db, eventId, quotaType) {
  const row = await db.queryOne(
    `UPDATE event_stall_quotas SET available = available - 1, updated_at = NOW()
      WHERE event_id = $1 AND quota_type = $2 AND available > 0
      RETURNING available`,
    [eventId, quotaType]
  );
  return row ? row.available : null;
}

export async function releaseSlot(db, eventId, quotaType) {
  await db.query(
    `UPDATE event_stall_quotas SET available = LEAST(total, available + 1), updated_at = NOW()
      WHERE event_id = $1 AND quota_type = $2`,
    [eventId, quotaType]
  );
}

// Registrations currently occupying a slot of the quota.
export async function heldCount(db, eventId, quotaType) {
  const row = await db.queryOne(
    `SELECT COUNT(*) AS n FROM vendor_registrations
      WHERE event_id = $1 AND quota_type = $2 AND deleted_at IS NULL AND status = ANY($3::text[])`,
    [eventId, quotaType, SLOT_HOLDING_STATUSES]
  );
  return row.n;
}

// Moves the oldest waitlisted applications into free slots (first come, first
// served) and returns the promoted ids. `excludeId` keeps an application the
// manager has just waitlisted from being promoted straight back.
export async function fillFromWaitlist(db, eventId, quotaType, excludeId = null) {
  const promoted = [];
  for (;;) {
    const quota = await db.queryOne(
      "SELECT available FROM event_stall_quotas WHERE event_id = $1 AND quota_type = $2 FOR UPDATE",
      [eventId, quotaType]
    );
    if (!quota || quota.available === 0) break;
    const next = await db.queryOne(
      `SELECT id FROM vendor_registrations
        WHERE event_id = $1 AND quota_type = $2 AND status = 'waitlisted' AND deleted_at IS NULL
          AND ($3::int IS NULL OR id <> $3)
        ORDER BY created_at ASC, id ASC LIMIT 1 FOR UPDATE`,
      [eventId, quotaType, excludeId]
    );
    if (!next) break;
    await takeSlot(db, eventId, quotaType);
    await db.query("UPDATE vendor_registrations SET status = 'pending', updated_at = NOW() WHERE id = $1", [next.id]);
    promoted.push(next.id);
  }
  return promoted;
}

// Sets a quota's size. It cannot shrink below the stalls already allocated;
// growing it promotes waitlisted applicants into the new slots.
export async function setQuotaTotal(db, eventId, quotaType, total) {
  const held = await heldCount(db, eventId, quotaType);
  if (total < held) return { ok: false, held };
  await db.query(
    `INSERT INTO event_stall_quotas (event_id, quota_type, total, available)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (event_id, quota_type)
     DO UPDATE SET total = EXCLUDED.total, available = EXCLUDED.available, updated_at = NOW()`,
    [eventId, quotaType, total, total - held]
  );
  const promoted = await fillFromWaitlist(db, eventId, quotaType);
  return { ok: true, held, promoted };
}

// Slot effect of a status change: "take" when an application starts holding
// a stall, "release" when it stops, otherwise nothing.
export function slotTransition(from, to) {
  const was = SLOT_HOLDING_STATUSES.includes(from);
  const will = SLOT_HOLDING_STATUSES.includes(to);
  if (!was && will) return "take";
  if (was && !will) return "release";
  return "none";
}
