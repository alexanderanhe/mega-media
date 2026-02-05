import { getCollections, ObjectId } from "~/server/db";
import { hashPassword } from "~/server/auth";
import { jsonOk, parseJson, requireRole, withApiErrorHandling, ApiError } from "~/server/http";
import { createUserSchema } from "~/server/schemas";

export const loader = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    await requireRole(request, "ADMIN");
    const { users } = await getCollections();
    const list = await users
      .find({}, { projection: { passwordHash: 0 } })
      .sort({ createdAt: -1 })
      .toArray();

    return jsonOk({
      items: list.map((item) => ({
        id: item._id.toString(),
        email: item.email,
        role: item.role,
        isActive: item.isActive,
        createdAt: item.createdAt,
      })),
    });
  })(request);

export const action = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    await requireRole(request, "ADMIN");
    const body = await parseJson(request, createUserSchema);
    const { users } = await getCollections();

    const existing = await users.findOne({ email: body.email.toLowerCase() });
    if (existing) throw new ApiError(409, "Email already exists");

    const created = await users.insertOne({
      _id: new ObjectId(),
      email: body.email.toLowerCase(),
      passwordHash: await hashPassword(body.password),
      role: body.role,
      isActive: true,
      createdAt: new Date(),
    });

    return jsonOk({ id: created.insertedId.toString() }, { status: 201 });
  })(request);
