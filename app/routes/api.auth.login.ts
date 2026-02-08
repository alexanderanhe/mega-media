import { getCollections } from "~/server/db";
import { createAccessToken, comparePassword, buildAccessCookie } from "~/server/auth";
import { jsonOk, parseJson, withApiErrorHandling, ApiError } from "~/server/http";
import { loginSchema } from "~/server/schemas";
import { rateLimit } from "~/server/rate-limit";

export const action = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    const ip = request.headers.get("x-forwarded-for") ?? "local";
    rateLimit(`login:${ip}`, 15, 60_000);

    const body = await parseJson(request, loginSchema);
    const { users } = await getCollections();
    const user = await users.findOne({ email: body.email.toLowerCase() });
    if (!user) throw new ApiError(401, "Invalid credentials");
    if (!user.isActive) throw new ApiError(403, "Access pending approval");

    const ok = await comparePassword(body.password, user.passwordHash);
    if (!ok) throw new ApiError(401, "Invalid credentials");

    const token = await createAccessToken({
      sub: user._id.toString(),
      role: user.role,
      email: user.email,
    });

    const headers = new Headers();
    headers.append("Set-Cookie", buildAccessCookie(token));
    return jsonOk(
      {
        ok: true,
        user: { id: user._id.toString(), email: user.email, role: user.role },
      },
      { headers },
    );
  })(request);
