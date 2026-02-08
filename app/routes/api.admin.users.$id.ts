import { getCollections, ObjectId } from "~/server/db";
import { hashPassword } from "~/server/auth";
import { jsonOk, parseJson, requireRole, withApiErrorHandling, ApiError } from "~/server/http";
import { patchUserSchema } from "~/server/schemas";

export const action = async ({ request, params }: { request: Request; params: { id: string } }) =>
  withApiErrorHandling(async () => {
    await requireRole(request, "ADMIN");
    if (!ObjectId.isValid(params.id)) throw new ApiError(400, "Invalid user id");
    const body = await parseJson(request, patchUserSchema);

    const patch: Record<string, unknown> = {};
    if (body.role) patch.role = body.role;
    if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
    if (body.approvalStatus) patch.approvalStatus = body.approvalStatus;
    if (body.name) patch.name = body.name;
    if (body.password) patch.passwordHash = await hashPassword(body.password);

    if (Object.keys(patch).length === 0) throw new ApiError(400, "No changes provided");

    const { users } = await getCollections();
    const result = await users.updateOne({ _id: new ObjectId(params.id) }, { $set: patch });
    if (!result.matchedCount) throw new ApiError(404, "User not found");

    return jsonOk({ ok: true });
  })(request);
