import { getCollections, ObjectId } from "~/server/db";
import { ApiError, jsonOk, optionalAuth, withApiErrorHandling } from "~/server/http";
import { createSignedGetUrl, toPublicUrl } from "~/server/r2";

export const loader = async ({ request, params }: { request: Request; params: { id: string } }) =>
  withApiErrorHandling(async () => {
    if (!ObjectId.isValid(params.id)) throw new ApiError(400, "Invalid media id");
    const auth = await optionalAuth(request);
    const { media } = await getCollections();
    const doc = await media.findOne({ _id: new ObjectId(params.id), type: "video", status: "ready" });
    if (!doc) throw new ApiError(404, "Video not found");
    if (doc.visibility === "PRIVATE" && !auth) throw new ApiError(403, "Forbidden");

    const playKey = doc.preview?.r2Key ?? doc.r2KeyOriginal;
    const posterKey = doc.poster?.r2Key ?? doc.variants.lod3?.r2Key;

    const playbackUrl = toPublicUrl(playKey) ?? (await createSignedGetUrl(playKey, 120));
    const posterUrl = posterKey ? toPublicUrl(posterKey) ?? (await createSignedGetUrl(posterKey, 120)) : null;

    return jsonOk({
      id: doc._id.toString(),
      playbackUrl,
      posterUrl,
      mime: doc.preview?.mime ?? "video/mp4",
    });
  })(request);
