import { createHash } from "node:crypto";
import { getCollections } from "~/server/db";
import { jsonOk, parseJson, withApiErrorHandling, ApiError } from "~/server/http";
import { verifyAccessCodeSchema } from "~/server/schemas";
import { rateLimit } from "~/server/rate-limit";

export const action = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    if ((process.env.ENABLE_SELF_SIGNUP ?? "").toLowerCase() !== "true") {
      throw new ApiError(404, "Not found");
    }

    const ip = request.headers.get("x-forwarded-for") ?? "local";
    rateLimit(`verify:${ip}`, 10, 10 * 60_000);

    const body = await parseJson(request, verifyAccessCodeSchema);
    const email = body.email.toLowerCase();
    const { users } = await getCollections();
    const user = await users.findOne({ email });
    if (!user) throw new ApiError(404, "User not found");

    if (!user.verificationCodeHash || !user.verificationCodeExpiresAt) {
      throw new ApiError(400, "No code requested");
    }
    if (user.verificationCodeExpiresAt.getTime() < Date.now()) {
      throw new ApiError(400, "Code expired");
    }

    const expected = hashCode(email, body.code);
    if (expected !== user.verificationCodeHash) {
      throw new ApiError(401, "Invalid code");
    }

    await users.updateOne(
      { _id: user._id },
      {
        $set: { emailVerifiedAt: new Date() },
        $unset: { verificationCodeHash: "", verificationCodeExpiresAt: "" },
      },
    );

    return jsonOk({ ok: true });
  })(request);

function hashCode(email: string, code: string) {
  const secret = process.env.JWT_SECRET ?? "secret";
  return createHash("sha256").update(`${email}:${code}:${secret}`).digest("hex");
}
