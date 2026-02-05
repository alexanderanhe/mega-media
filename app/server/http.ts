import { z } from "zod";
import { readAccessToken, verifyAccessToken } from "./auth";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function jsonOk(data: unknown, init?: ResponseInit) {
  return Response.json(data, init);
}

export function jsonError(status: number, message: string, extra?: Record<string, unknown>) {
  return Response.json({ error: message, ...extra }, { status });
}

export async function parseJson<T>(request: Request, schema: z.ZodSchema<T>) {
  const raw = await request.json();
  return schema.parse(raw);
}

export async function parseQuery<T>(request: Request, schema: z.ZodSchema<T>) {
  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  return schema.parse(params);
}

export async function requireAuth(request: Request) {
  const token = readAccessToken(request);
  if (!token) throw new ApiError(401, "Unauthorized");
  try {
    return await verifyAccessToken(token);
  } catch {
    throw new ApiError(401, "Unauthorized");
  }
}

export async function optionalAuth(request: Request) {
  const token = readAccessToken(request);
  if (!token) return null;
  try {
    return await verifyAccessToken(token);
  } catch {
    return null;
  }
}

export async function requireRole(request: Request, role: "ADMIN") {
  const auth = await requireAuth(request);
  if (auth.role !== role) throw new ApiError(403, "Forbidden");
  return auth;
}

export function withApiErrorHandling(handler: (request: Request, args?: unknown) => Promise<Response>) {
  return async (request: Request, args?: unknown) => {
    try {
      return await handler(request, args);
    } catch (error) {
      if (error instanceof ApiError) return jsonError(error.status, error.message);
      if (error instanceof z.ZodError) {
        return jsonError(400, "Invalid request", { issues: error.flatten() });
      }
      console.error(error);
      return jsonError(500, "Internal server error");
    }
  };
}
