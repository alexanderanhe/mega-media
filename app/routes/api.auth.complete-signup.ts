import { getCollections } from "~/server/db";
import { hashPassword } from "~/server/auth";
import { jsonOk, parseJson, withApiErrorHandling, ApiError } from "~/server/http";
import { completeSignupSchema } from "~/server/schemas";
import { rateLimit } from "~/server/rate-limit";

export const action = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    if ((process.env.ENABLE_SELF_SIGNUP ?? "").toLowerCase() !== "true") {
      throw new ApiError(404, "Not found");
    }

    const ip = request.headers.get("x-forwarded-for") ?? "local";
    rateLimit(`complete:${ip}`, 6, 10 * 60_000);

    const body = await parseJson(request, completeSignupSchema);
    const email = body.email.toLowerCase();
    const { users } = await getCollections();
    const user = await users.findOne({ email });
    if (!user) throw new ApiError(404, "User not found");
    if (!user.emailVerifiedAt) throw new ApiError(400, "Email not verified");
    if (user.isActive) throw new ApiError(409, "Account already active");

    await users.updateOne(
      { _id: user._id },
      {
        $set: {
          passwordHash: await hashPassword(body.password),
          requestMessage: body.requestMessage,
          requestedAt: new Date(),
          approvalStatus: "pending",
          isActive: false,
        },
      },
    );

    return jsonOk({ ok: true });
  })(request);
