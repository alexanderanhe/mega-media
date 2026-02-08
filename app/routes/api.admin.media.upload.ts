import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { getCollections, ObjectId } from "~/server/db";
import { uploadBufferToR2 } from "~/server/r2";
import { enqueueMediaProcessing } from "~/server/media-processor";
import { ApiError, jsonOk, requireRole, withApiErrorHandling } from "~/server/http";

const ACCEPTED_IMAGE = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const ACCEPTED_VIDEO = new Set(["video/mp4", "video/quicktime", "video/webm"]);

export const action = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    await requireRole(request, "ADMIN");

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(400, "Missing file");

    const visibilityRaw = form.get("visibility");
    let visibility: "PUBLIC" | "PRIVATE" = "PRIVATE";
    if (typeof visibilityRaw === "string" && visibilityRaw) {
      if (visibilityRaw !== "PUBLIC" && visibilityRaw !== "PRIVATE") {
        throw new ApiError(400, "Invalid visibility");
      }
      visibility = visibilityRaw;
    }

    const dateTakenRaw = form.get("dateTaken");
    const manualDateTaken =
      typeof dateTakenRaw === "string" && dateTakenRaw ? new Date(dateTakenRaw) : null;
    if (manualDateTaken && Number.isNaN(manualDateTaken.getTime())) {
      throw new ApiError(400, "Invalid dateTaken");
    }

    const placeNameRaw = form.get("placeName");
    const placeName = typeof placeNameRaw === "string" && placeNameRaw ? placeNameRaw : undefined;

    const titleRaw = form.get("title");
    const descriptionRaw = form.get("description");
    const title = typeof titleRaw === "string" && titleRaw.trim() ? titleRaw.trim() : file.name;
    const description = typeof descriptionRaw === "string" ? descriptionRaw : "";

    const latRaw = form.get("lat");
    const lngRaw = form.get("lng");
    const lat = typeof latRaw === "string" && latRaw ? Number.parseFloat(latRaw) : null;
    const lng = typeof lngRaw === "string" && lngRaw ? Number.parseFloat(lngRaw) : null;
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);

    const type = ACCEPTED_IMAGE.has(file.type)
      ? "image"
      : ACCEPTED_VIDEO.has(file.type)
        ? "video"
        : null;

    if (!type) throw new ApiError(400, "Unsupported file type");

    if (file.size > 500 * 1024 * 1024) {
      throw new ApiError(413, "File exceeds 500MB limit");
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const fileHash = createHash("sha256").update(bytes).digest("hex");

    const now = new Date();
    const { media } = await getCollections();
    const existing = await media.findOne({ fileHash });
    if (existing) {
      await media.updateOne(
        { _id: existing._id },
        {
          $set: {
            visibility,
            title,
            description,
            dateTaken: manualDateTaken,
            dateEffective: manualDateTaken ?? existing.dateEffective ?? existing.createdAt,
            location: hasCoords
              ? { lat: lat as number, lng: lng as number, source: "exif", placeName }
              : placeName
                ? { lat: 0, lng: 0, source: "manual", placeName }
                : null,
          },
        },
      );
      return jsonOk({ id: existing._id.toString(), status: existing.status, duplicate: true, replaced: true }, { status: 200 });
    }

    const id = new ObjectId();
    const extension = extensionFromFile(file.name, file.type, type);
    const originalKey = `media/${id.toString()}/original.${extension}`;

    const tmpPath = path.join(os.tmpdir(), `${id.toString()}-original.${extension}`);
    await fs.writeFile(tmpPath, bytes);

    await uploadBufferToR2({
      key: originalKey,
      body: bytes,
      contentType: file.type || fallbackMime(type),
      cacheControl: "public, max-age=31536000, immutable",
    });

    try {
      await media.insertOne({
        _id: id,
        type,
        visibility,
        title,
        description,
        fileHash,
        tags: [],
        category: null,
        createdAt: now,
        dateTaken: manualDateTaken,
        dateEffective: manualDateTaken ?? now,
        location: hasCoords
          ? { lat: lat as number, lng: lng as number, source: "exif", placeName }
          : placeName
            ? { lat: 0, lng: 0, source: "manual", placeName }
            : null,
        r2KeyOriginal: originalKey,
        variants: {},
        poster: null,
        preview: null,
        width: null,
        height: null,
        aspect: 1,
        status: "processing",
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        const dup = await media.findOne({ fileHash });
        await fs.unlink(tmpPath).catch(() => undefined);
        return jsonOk({ id: dup?._id?.toString(), status: dup?.status ?? "processing", duplicate: true }, { status: 200 });
      }
      throw err;
    }

    enqueueMediaProcessing({
      mediaId: id.toString(),
      localPath: tmpPath,
      type,
      mime: file.type || fallbackMime(type),
      extension,
      manualDateTaken,
      placeName,
    });

    return jsonOk({ id: id.toString(), status: "processing", duplicate: false }, { status: 202 });
  })(request);

function extensionFromFile(name: string, mime: string, type: "image" | "video") {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext && ext.length <= 5) return ext;
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "video/mp4") return "mp4";
  return type === "image" ? "jpg" : "mp4";
}

function fallbackMime(type: "image" | "video") {
  return type === "image" ? "image/jpeg" : "video/mp4";
}
