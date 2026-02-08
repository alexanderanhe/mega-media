import { createHash } from "node:crypto";
import { getCollections, ObjectId } from "~/server/db";
import { sendVerificationEmail } from "~/server/resend";
import { jsonOk, parseJson, withApiErrorHandling, ApiError } from "~/server/http";
import { requestAccessSchema } from "~/server/schemas";
import { rateLimit } from "~/server/rate-limit";

const CODE_TTL_MS = 10 * 60_000;

export const action = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    if ((process.env.ENABLE_SELF_SIGNUP ?? "").toLowerCase() !== "true") {
      throw new ApiError(404, "Not found");
    }

    const ip = request.headers.get("x-forwarded-for") ?? "local";
    rateLimit(`signup:${ip}`, 5, 10 * 60_000);

    const body = await parseJson(request, requestAccessSchema);
    const email = body.email.toLowerCase();
    rateLimit(`signup-email:${email}`, 3, 10 * 60_000);
    const code = generateCode();
    const codeHash = hashCode(email, code);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CODE_TTL_MS);

    const { users } = await getCollections();
    const existing = await users.findOne({ email });
    if (existing?.isActive) {
      throw new ApiError(409, "Account already active");
    }

    if (existing) {
      await users.updateOne(
        { _id: existing._id },
        {
          $set: {
            name: body.name,
            role: existing.role ?? "VIEWER",
            isActive: false,
            approvalStatus: existing.approvalStatus ?? "pending",
            verificationCodeHash: codeHash,
            verificationCodeExpiresAt: expiresAt,
            verificationSentAt: now,
          },
        },
      );
    } else {
      await users.insertOne({
        _id: new ObjectId(),
        email,
        passwordHash: "",
        role: "VIEWER",
        isActive: false,
        approvalStatus: "pending",
        name: body.name,
        createdAt: now,
        verificationCodeHash: codeHash,
        verificationCodeExpiresAt: expiresAt,
        verificationSentAt: now,
      });
    }

    await sendVerificationEmail({ to: email, name: body.name, code });
    return jsonOk({ ok: true });
  })(request);

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashCode(email: string, code: string) {
  const secret = process.env.JWT_SECRET ?? "secret";
  return createHash("sha256").update(`${email}:${code}:${secret}`).digest("hex");
}
