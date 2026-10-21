export class AppError extends Error {
  constructor(code, message, status = 400, details = []) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function notFound(resource = "Resource") {
  return new AppError("NOT_FOUND", `${resource} not found`, 404);
}

export function unauthorized(msg = "Authentication required") {
  return new AppError("UNAUTHENTICATED", msg, 401);
}

export function forbidden(msg = "You do not have permission to perform this action") {
  return new AppError("FORBIDDEN", msg, 403);
}

export function conflict(msg, field) {
  return new AppError("CONFLICT", msg, 409, field ? [{ field, message: msg }] : []);
}

export function validation(details) {
  return new AppError(
    "VALIDATION_ERROR",
    "Validation failed",
    422,
    Array.isArray(details) ? details : [{ field: "body", message: details }]
  );
}

// Converts zod issues into the API's { field, message } detail shape.
export function issuesOf(error) {
  return error.issues.map((i) => ({ field: i.path.join("."), message: i.message }));
}

// Parses data with a zod schema, throwing a 422 with field details on failure.
export function parseOrThrow(schema, data) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw validation(issuesOf(parsed.error));
  return parsed.data;
}

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function success(res, data, status = 200) {
  return res.status(status).json({ data });
}

export function paginated(res, rows, total, page, pageSize) {
  return res.json({
    data: rows,
    meta: { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  });
}
