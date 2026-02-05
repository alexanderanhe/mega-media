import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { parse as parseCookie, serialize } from "cookie";
import { getEnv } from "./env";
import type { UserRole } from "~/shared/types";

const ACCESS_COOKIE = "mmg_access";

type AuthPayload = {
  sub: string;
  role: UserRole;
  email: string;
};

function getSecret() {
  const env = getEnv();
  return new TextEncoder().encode(env.JWT_SECRET);
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export async function comparePassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export async function createAccessToken(payload: AuthPayload) {
  const env = getEnv();
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(env.JWT_EXPIRES_IN ?? "15m")
    .sign(getSecret());
}

export async function verifyAccessToken(token: string) {
  const result = await jwtVerify<AuthPayload>(token, getSecret());
  return result.payload;
}

export function parseCookies(request: Request) {
  return parseCookie(request.headers.get("cookie") ?? "");
}

export function readAccessToken(request: Request) {
  const cookies = parseCookies(request);
  return cookies[ACCESS_COOKIE] ?? null;
}

export function buildAccessCookie(token: string) {
  const isProd = (process.env.NODE_ENV ?? "development") === "production";
  return serialize(ACCESS_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 15,
  });
}

export function buildClearAccessCookie() {
  const isProd = (process.env.NODE_ENV ?? "development") === "production";
  return serialize(ACCESS_COOKIE, "", {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export type { AuthPayload };
