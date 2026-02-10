import { getCollections, ObjectId } from "~/server/db";
import { ApiError, jsonOk, requireAuth, withApiErrorHandling } from "~/server/http";

export const action = async ({ request, params }: { request: Request; params: { id: string } }) =>
  withApiErrorHandling(async () => {
    const auth = await requireAuth(request);
    if (!ObjectId.isValid(params.id)) throw new ApiError(400, "Invalid media id");

    const { media, likes } = await getCollections();
    const mediaId = new ObjectId(params.id);
    const existing = await media.findOne({ _id: mediaId });
    if (!existing) throw new ApiError(404, "Media not found");

    const userId = new ObjectId(auth.sub);

    if (request.method === "DELETE") {
      await likes.deleteOne({ userId, mediaId });
      return jsonOk({ ok: true, liked: false });
    }

    await likes.updateOne(
      { userId, mediaId },
      { $setOnInsert: { _id: new ObjectId(), userId, mediaId, createdAt: new Date() } },
      { upsert: true },
    );
    return jsonOk({ ok: true, liked: true });
  })(request);
