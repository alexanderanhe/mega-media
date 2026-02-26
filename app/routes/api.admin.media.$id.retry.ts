import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getCollections, ObjectId } from "~/server/db";
import { downloadObjectToFile } from "~/server/r2";
import { enqueueMediaProcessing } from "~/server/media-processor";
import { ApiError, jsonOk, requireRole, withApiErrorHandling } from "~/server/http";

export const action = async ({ request, params }: { request: Request; params: { id: string } }) =>
  withApiErrorHandling(async () => {
    await requireRole(request, "ADMIN");
    if (!ObjectId.isValid(params.id)) throw new ApiError(400, "Invalid media id");

    const { media } = await getCollections();
    const existing = await media.findOne({ _id: new ObjectId(params.id) });
    if (!existing) throw new ApiError(404, "Media not found");
    if (!existing.r2KeyOriginal) throw new ApiError(400, "Missing original file");
    if (existing.mergeLocked) throw new ApiError(409, "Media is locked for merge");
    if (existing.status === "processing") throw new ApiError(409, "Media is already processing");

    const tmpPath = path.join(os.tmpdir(), `${existing._id.toString()}-retry`);
    await downloadObjectToFile(existing.r2KeyOriginal, tmpPath);

    await media.updateOne(
      { _id: new ObjectId(params.id) },
      {
        $set: {
          status: "processing",
          errorMessage: null,
        },
      },
    );

    const rawExt = existing.r2KeyOriginal.split(".").pop() || "";
    const extension = rawExt || (existing.type === "video" ? "mp4" : "jpg");
    const mime = resolveMime(existing.type, extension);

    enqueueMediaProcessing({
      mediaId: existing._id.toString(),
      localPath: tmpPath,
      type: existing.type,
      mime,
      extension,
    });

    return jsonOk({ ok: true });
  })(request);

function resolveMime(type: "image" | "video", extension: string) {
  const ext = extension.toLowerCase();
  if (type === "video") {
    if (ext === "webm") return "video/webm";
    if (ext === "mov" || ext === "qt") return "video/quicktime";
    return "video/mp4";
  }
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic" || ext === "heif") return "image/heic";
  return "image/jpeg";
}
