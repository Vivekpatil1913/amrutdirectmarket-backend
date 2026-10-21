# AMRUT Peth CMS — API reference

Base URL: `/api/v1` (default backend port `4200`).

## Conventions

| | |
|---|---|
| Success | `{ "data": … }` — lists add `"meta": { total, page, pageSize, totalPages }` |
| Error | `{ "error": { "code", "message", "details": [{ "field", "message" }] } }` |
| Auth | `Authorization: Bearer <token>` (or the `ap_admin_session` httpOnly cookie set at login) |
| Statuses | `200` ok · `201` created · `304` not modified · `400` bad request · `401` not signed in · `403` role too low / origin not allowed · `404` not found · `409` duplicate / in use · `413` file too large · `422` validation · `423` account locked · `429` rate limited · `500` unexpected |

Every response carries an `X-Request-Id` header; unexpected errors are logged with it. Stack traces and SQL errors are never returned.

**Roles:** `editor` < `admin` < `superadmin`. Editors create, edit and publish content. Deleting/restoring, Site Settings and Contact Details need `admin`. User management needs `superadmin`.

**Soft delete:** every `DELETE` sets `deleted_at`; rows are never removed. Deleted rows are excluded from lists (`?trash=true` shows them), from `GET /:id`, and from every public endpoint. `POST /:id/restore` brings a row back (refused with `409` if a live row now uses its unique slug/code).

**List query parameters** (all admin lists): `page` (1…), `limit` (1–100), `search`, `status`, `sort`, `order` (`asc|desc`), `trash=true`, plus the module filters listed below.

---

## Health

`GET /health` → `{ status: "ok", database: "connected", uptimeSeconds, time }`

## Public (no authentication)

| Method | Path | Description |
|---|---|---|
| GET | `/public/site` | Everything the home page renders: `{ sections: { settings, contact, hero, about, highlights, participate, register, footer }, collections: { navItems, heroFacts, quickLinks, categories, highlights, eligibilityGroups, participationSteps, enquirySubjects, socialLinks } }`. Published, non-deleted content only; image fields are URLs. `Cache-Control: no-cache` + ETag. |
| GET | `/public/sections/:key` | One published section. |
| GET | `/public/<collection>` | Published records of one collection, in display order. |
| POST | `/public/enquiries` | Submit the registration/enquiry form. Rate-limited (10 / 15 min / IP). |

`POST /public/enquiries` body:

```json
{ "name": "Asha Patil", "email": "asha@example.com", "phone": "9876543210",
  "subject": "stall", "message": "At least 20 characters…", "consent": true,
  "language": "mr", "website": "" }
```

`phone` optional (Indian 10-digit mobile), `subject` must be the `code` of a published enquiry subject, `website` is a honeypot and must stay empty. → `201 { data: { received: true, id } }`.

## Authentication

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/login` | – | `{ email, password }` → `{ token, expiresAt, user }`. Rate-limited; locks the account for `LOGIN_LOCK_MINUTES` after `LOGIN_MAX_ATTEMPTS` failures (`423`). |
| POST | `/auth/logout` | – | Revokes the session. |
| GET | `/auth/me` | any | Current user. |
| PUT | `/auth/profile` | any | `{ name, email }` |
| POST | `/auth/change-password` | any | `{ currentPassword, newPassword }` (≥ 8 chars, letter + number). Signs out other sessions. |

Sessions are stored in `admin_sessions`, expire after `SESSION_HOURS` of inactivity (sliding) and are revoked on logout, password change, account disable or delete.

## Admin

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/admin/meta` | editor | Field specs for every section and collection, icon / section-target / role / status lists, upload size limit. The admin forms are rendered from this. |
| GET | `/admin/dashboard` | editor | Live counts, enquiry trend (12 months), status split, last 7 days, per-module content counts, latest enquiries, recent activity. |

### Page sections — `/admin/sections`

Keys: `settings`, `contact` (admin role), `hero`, `about`, `highlights`, `participate`, `register`, `footer`. Each has a **draft** and a **published** copy; the site only reads the published one.

| Method | Path | Description |
|---|---|---|
| GET | `/admin/sections` | Summary of all sections (published / has draft changes / timestamps). |
| GET | `/admin/sections/meta` | Section field specs. |
| GET | `/admin/sections/:key` | `{ draft, published, has_unpublished_changes, published_at, updated_at, … }` |
| PUT | `/admin/sections/:key` | Save draft (full section object). `?publish=true` saves and publishes in one transaction. |
| POST | `/admin/sections/:key/publish` | Re-validates and publishes the draft. |
| POST | `/admin/sections/:key/discard` | Resets the draft to the published copy. |

Image fields are `{ "media_id": 12, "url": "" }`; the server checks the media exists and fills `url` from the library.

### Content collections — `/admin/<collection>`

| Collection | Table | Extra filters | Unique |
|---|---|---|---|
| `nav-items` | `nav_items` | `section` | |
| `hero-facts` | `hero_facts` | | |
| `quick-links` | `quick_links` | `section` | |
| `categories` | `categories` | | `slug` (auto from English name if empty) |
| `highlights` | `highlights` | | |
| `eligibility-groups` | `eligibility_groups` | | |
| `participation-steps` | `participation_steps` | | |
| `enquiry-subjects` | `enquiry_subjects` | | `code` (auto from English label if empty) |
| `social-links` | `social_links` | | |

All share `display_order` and `status` (`published|draft`). Sort keys: `display_order`, `status`, `created_at`, `updated_at`, `id`, and the title column.

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/admin/<c>` | editor | Paginated list. |
| GET | `/admin/<c>/:id` | editor | One record (`?trash=true` to read a deleted one). |
| POST | `/admin/<c>` | editor | Create → `201`. |
| PUT | `/admin/<c>/:id` | editor | Update. |
| PATCH | `/admin/<c>/:id/status` | editor | `{ "status": "published" | "draft" }` |
| DELETE | `/admin/<c>/:id` | admin | Soft delete. |
| POST | `/admin/<c>/:id/restore` | admin | Restore. |

### Enquiries — `/admin/enquiries`

Filters: `status` (`new|reviewed|actioned|archived`), `subject` (code), `from` / `to` (`YYYY-MM-DD`). Sort: `created_at`, `name`, `status`.

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/admin/enquiries` | editor | List. |
| GET | `/admin/enquiries/:id` | editor | Detail. |
| PATCH | `/admin/enquiries/:id` | editor | `{ status?, admin_notes? }` — records reviewer and time. |
| DELETE | `/admin/enquiries/:id` | admin | Soft delete. |
| POST | `/admin/enquiries/:id/restore` | admin | Restore. |

### Media — `/admin/media`

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/admin/media` | editor | List (`search`, `type`, `trash`). |
| GET | `/admin/media/:id` | editor | Detail plus `usage` (sections referencing it). |
| POST | `/admin/media/upload` | editor | `multipart/form-data`: `file` (+ optional `alt_text`). JPEG/PNG/WebP/GIF up to `MAX_FILE_SIZE_MB`; the file content must match its type. Stored under a random name in `uploads/media/`. |
| PUT | `/admin/media/:id` | editor | `{ alt_text }` |
| DELETE | `/admin/media/:id` | admin | Soft delete; `409` while a page section uses the image. |
| POST | `/admin/media/:id/restore` | admin | Restore. |

Files are served from `/uploads/media/<file>` (no directory listing, `nosniff`).

### Users — `/admin/users` (superadmin)

`GET` (filters `role`, `active`), `GET /:id`, `POST { name, email, role, password, is_active }`, `PUT /:id` (empty `password` keeps the current one), `DELETE /:id` (soft; not yourself; not the last active super admin), `POST /:id/restore` (comes back inactive).

### Activity log — `/admin/activity` (admin)

Read-only audit trail: `GET` with `search`, `action`, `entity`.
