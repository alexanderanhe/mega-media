import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import busboy from "busboy";
import { getCollections, ObjectId } from "~/server/db";
import { uploadBufferToR2, uploadFileToR2 } from "~/server/r2";
import { enqueueMediaProcessing } from "~/server/media-processor";
import { ApiError, jsonOk, requireRole, withApiErrorHandling } from "~/server/http";

const ACCEPTED_IMAGE = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const ACCEPTED_VIDEO = new Set(["video/mp4", "video/quicktime", "video/webm"]);

export const action = async ({ request }: { request: Request }) =>
  withApiErrorHandling(async () => {
    await requireRole(request, "ADMIN");

    const { fields, file } = await parseMultipart(request);

    const visibilityRaw = fields.visibility;
    let visibility: "PUBLIC" | "PRIVATE" = "PRIVATE";
    if (typeof visibilityRaw === "string" && visibilityRaw) {
      if (visibilityRaw !== "PUBLIC" && visibilityRaw !== "PRIVATE") {
        throw new ApiError(400, "Invalid visibility");
      }
      visibility = visibilityRaw;
    }

    const dateTakenRaw = fields.dateTaken;
    const manualDateTaken =
      typeof dateTakenRaw === "string" && dateTakenRaw ? new Date(dateTakenRaw) : null;
    if (manualDateTaken && Number.isNaN(manualDateTaken.getTime())) {
      throw new ApiError(400, "Invalid dateTaken");
    }

    const placeNameRaw = fields.placeName;
    const placeName = typeof placeNameRaw === "string" && placeNameRaw ? placeNameRaw : undefined;

    const titleRaw = fields.title;
    const descriptionRaw = fields.description;
    const title = typeof titleRaw === "string" && titleRaw.trim() ? titleRaw.trim() : file.filename;
    const description = typeof descriptionRaw === "string" ? descriptionRaw : "";

    const latRaw = fields.lat;
    const lngRaw = fields.lng;
    const lat = typeof latRaw === "string" && latRaw ? Number.parseFloat(latRaw) : null;
    const lng = typeof lngRaw === "string" && lngRaw ? Number.parseFloat(lngRaw) : null;
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);

    const type = ACCEPTED_IMAGE.has(file.mimeType)
      ? "image"
      : ACCEPTED_VIDEO.has(file.mimeType)
        ? "video"
        : null;

    if (!type) throw new ApiError(400, "Unsupported file type");

    if (file.size > 500 * 1024 * 1024) {
      throw new ApiError(413, "File exceeds 500MB limit");
    }

    const partInfo = type === "video" ? parsePartFilename(file.filename) : null;
    if (partInfo) {
      const { mediaParts } = await getCollections();
      const now = new Date();
      const groupKey = `${partInfo.baseName}.${partInfo.extension}`;
      const groupHash = createHash("sha1").update(groupKey).digest("hex");
      const r2Key = `multipart/${groupHash}/part${String(partInfo.partNumber).padStart(4, "0")}.${partInfo.extension}`;
      const location = hasCoords
        ? { lat: lat as number, lng: lng as number, source: "exif", placeName }
        : placeName
          ? { lat: 0, lng: 0, source: "manual", placeName }
          : null;
      const normalizedTitle =
        typeof titleRaw === "string" && titleRaw.trim() ? titleRaw.trim() : partInfo.baseName;

      await uploadFileToR2({
        key: r2Key,
        filePath: file.path,
        contentType: file.mimeType || "video/mp4",
        cacheControl: "public, max-age=31536000, immutable",
      });

      await mediaParts.updateOne(
        { groupKey, partNumber: partInfo.partNumber },
        {
          $set: {
            groupKey,
            groupHash,
            baseName: partInfo.baseName,
            originalName: file.filename,
            extension: partInfo.extension,
            partNumber: partInfo.partNumber,
            r2Key,
            bytes: file.size,
            status: "pending",
            visibility,
            title: normalizedTitle,
            description,
            dateTaken: manualDateTaken,
            location,
            updatedAt: now,
          },
          $setOnInsert: {
            _id: new ObjectId(),
            createdAt: now,
          },
          $unset: {
            errorMessage: "",
          },
        },
        { upsert: true },
      );

      await fs.unlink(file.path).catch(() => undefined);
      return jsonOk(
        { status: "queued-merge", groupKey, partNumber: partInfo.partNumber },
        { status: 202 },
      );
    }

    const bytes = await fs.readFile(file.path);
    const fileHash = file.hash;

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
      await fs.unlink(file.path).catch(() => undefined);
      return jsonOk({ id: existing._id.toString(), status: existing.status, duplicate: true, replaced: true }, { status: 200 });
    }

    const id = new ObjectId();
    const extension = extensionFromFile(file.filename, file.mimeType, type);
    const originalKey = `media/${id.toString()}/original.${extension}`;

    const tmpPath = file.path;

    await uploadBufferToR2({
      key: originalKey,
      body: bytes,
      contentType: file.mimeType || fallbackMime(type),
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
        originalBytes: file.size,
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
      mime: file.mimeType || fallbackMime(type),
      extension,
      manualDateTaken,
      placeName,
    });

    return jsonOk({ id: id.toString(), status: "processing", duplicate: false }, { status: 202 });
  })(request);

type ParsedUpload = {
  fields: Record<string, string>;
  file: { path: string; filename: string; mimeType: string; size: number; hash: string };
};

async function parseMultipart(request: Request): Promise<ParsedUpload> {
  const headers = Object.fromEntries(request.headers);
  return new Promise((resolve, reject) => {
    const bb = busboy({
      headers,
      limits: { fileSize: 500 * 1024 * 1024 },
    });
    const fields: Record<string, string> = {};
    let fileMeta: ParsedUpload["file"] | null = null;
    let fileDone: Promise<void> | null = null;

    bb.on("field", (name, value) => {
      fields[name] = value;
    });

    bb.on("file", (name, stream, info) => {
      if (name !== "file") {
        stream.resume();
        return;
      }
      const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${Math.random().toString(16).slice(2)}-upload`);
      const hash = createHash("sha256");
      let size = 0;
      const out = createWriteStream(tmpPath);

      stream.on("data", (chunk) => {
        size += chunk.length;
        hash.update(chunk);
      });
      stream.on("limit", () => {
        out.destroy(new Error("File exceeds 500MB limit"));
      });

      fileDone = new Promise((res, rej) => {
        out.on("finish", () => {
          fileMeta = {
            path: tmpPath,
            filename: info.filename ?? "upload",
            mimeType: info.mimeType ?? "",
            size,
            hash: hash.digest("hex"),
          };
          res();
        });
        out.on("error", rej);
        stream.on("error", rej);
      });

      stream.pipe(out);
    });

    bb.on("error", reject);
    bb.on("finish", async () => {
      try {
        if (fileDone) await fileDone;
        if (!fileMeta) throw new ApiError(400, "Missing file");
        resolve({ fields, file: fileMeta });
      } catch (err) {
        reject(err);
      }
    });

    if (!request.body) {
      reject(new ApiError(400, "Missing body"));
      return;
    }
    Readable.fromWeb(request.body as any).pipe(bb);
  });
}

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

function parsePartFilename(filename: string) {
  const match = /^(.*)-part(\d+)\.([a-z0-9]{1,5})$/i.exec(filename.trim());
  if (!match) return null;
  const baseName = match[1].trim();
  const partNumber = Number.parseInt(match[2], 10);
  const extension = match[3].toLowerCase();
  if (!baseName || !Number.isFinite(partNumber) || partNumber < 1) return null;
  return { baseName, partNumber, extension };
}
