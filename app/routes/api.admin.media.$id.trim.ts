import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import ffmpeg from "fluent-ffmpeg";
import { getCollections, ObjectId } from "~/server/db";
import { deleteObjects, downloadObjectToFile, uploadFileToR2 } from "~/server/r2";
import { ApiError, jsonOk, parseJson, requireRole, withApiErrorHandling } from "~/server/http";
import { trimMediaSchema } from "~/server/schemas";
import { enqueueMediaProcessing } from "~/server/media-processor";

if (process.env.FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}

export const action = async ({ request, params }: { request: Request; params: { id: string } }) =>
  withApiErrorHandling(async () => {
    await requireRole(request, "ADMIN");
    if (!ObjectId.isValid(params.id)) throw new ApiError(400, "Invalid media id");

    const body = await parseJson(request, trimMediaSchema);
    if (body.endSeconds <= body.startSeconds) throw new ApiError(400, "End time must be after start time");

    const durationSeconds = body.endSeconds - body.startSeconds;
    if (durationSeconds < 6) throw new ApiError(400, "Trimmed video must be at least 6 seconds");

    const { media } = await getCollections();
    const existing = await media.findOne({ _id: new ObjectId(params.id) });
    if (!existing) throw new ApiError(404, "Media not found");
    if (existing.type !== "video") throw new ApiError(400, "Only videos can be trimmed");
    if (existing.status !== "ready") throw new ApiError(409, "Video must be ready to trim");
    if (existing.mergeLocked) throw new ApiError(409, "Media is locked for merge");
    if (!existing.r2KeyOriginal) throw new ApiError(400, "Missing original video");

    const inputPath = path.join(os.tmpdir(), `${existing._id.toString()}-original`);
    await downloadObjectToFile(existing.r2KeyOriginal, inputPath);

    const probe = await ffprobeSafe(inputPath);
    if (!probe.duration || !Number.isFinite(probe.duration)) {
      await fs.unlink(inputPath).catch(() => undefined);
      throw new ApiError(400, "Unable to read video duration");
    }
    if (body.startSeconds >= probe.duration) {
      await fs.unlink(inputPath).catch(() => undefined);
      throw new ApiError(400, "Start time exceeds duration");
    }
    const safeEndSeconds = Math.min(body.endSeconds, probe.duration);
    if (safeEndSeconds <= body.startSeconds) {
      await fs.unlink(inputPath).catch(() => undefined);
      throw new ApiError(400, "End time exceeds duration");
    }

    const originalSize = (await fs.stat(inputPath)).size;
    const originalExt = extFromKey(existing.r2KeyOriginal);

    const copyPath = path.join(os.tmpdir(), `${existing._id.toString()}-trim.${originalExt}`);
    const finalDurationSeconds = safeEndSeconds - body.startSeconds;
    if (finalDurationSeconds < 6) {
      await fs.unlink(inputPath).catch(() => undefined);
      throw new ApiError(400, "Trimmed video must be at least 6 seconds");
    }
    const copyOk = await trimCopy(inputPath, copyPath, body.startSeconds, finalDurationSeconds);
    if (!copyOk) {
      await fs.unlink(inputPath).catch(() => undefined);
      throw new ApiError(400, "Unable to trim video");
    }

    let finalPath = copyPath;
    let finalExt = originalExt;
    let usedReencode = false;

    const copySize = (await fs.stat(copyPath)).size;
    if (copySize >= originalSize) {
      usedReencode = true;
      finalExt = "mp4";
      const reencodePath = path.join(os.tmpdir(), `${existing._id.toString()}-trim-reencode.mp4`);
      const reencodeOk = await trimReencode(inputPath, reencodePath, body.startSeconds, finalDurationSeconds);
      if (!reencodeOk) {
        await fs.unlink(inputPath).catch(() => undefined);
        await fs.unlink(copyPath).catch(() => undefined);
        throw new ApiError(400, "Unable to trim video");
      }
      const reencodeSize = (await fs.stat(reencodePath)).size;
      if (reencodeSize >= originalSize) {
        await fs.unlink(inputPath).catch(() => undefined);
        await fs.unlink(copyPath).catch(() => undefined);
        await fs.unlink(reencodePath).catch(() => undefined);
        throw new ApiError(400, "Trim result is larger than original");
      }
      finalPath = reencodePath;
    }

    if (usedReencode) {
      await fs.unlink(copyPath).catch(() => undefined);
    }

    const finalKey = `media/${existing._id.toString()}/original.${finalExt}`;
    const contentType = mimeFromExt(finalExt);
    const finalSize = (await fs.stat(finalPath)).size;

    const newHash = await hashFile(finalPath);

    const deleteKeys = [
      existing.r2KeyOriginal,
      ...Object.values(existing.variants ?? {}).map((variant) => variant.r2Key),
      existing.poster?.r2Key,
      existing.preview?.r2Key,
      existing.blur?.r2Key,
    ].filter(Boolean) as string[];

    if (existing.r2KeyOriginal && existing.r2KeyOriginal !== finalKey) {
      deleteKeys.push(existing.r2KeyOriginal);
    }

    await media.updateOne(
      { _id: new ObjectId(params.id) },
      {
        $set: {
          r2KeyOriginal: finalKey,
          originalBytes: finalSize,
          fileHash: newHash,
          status: "processing",
          variants: {},
          poster: null,
          preview: null,
          blur: null,
          width: null,
          height: null,
          aspect: 1,
        },
        $unset: {
          errorMessage: "",
        },
      },
    );

    await uploadFileToR2({
      key: finalKey,
      filePath: finalPath,
      contentType,
      cacheControl: "public, max-age=31536000, immutable",
    });

    await deleteObjects(deleteKeys.filter((key) => key !== finalKey));

    enqueueMediaProcessing({
      mediaId: existing._id.toString(),
      localPath: finalPath,
      type: "video",
      mime: contentType,
      extension: finalExt,
    });

    await fs.unlink(inputPath).catch(() => undefined);

    return jsonOk({ ok: true, reencoded: usedReencode });
  })(request);

function extFromKey(key: string) {
  const ext = path.extname(key).replace(".", "").toLowerCase();
  return ext || "mp4";
}

function mimeFromExt(ext: string) {
  if (ext === "mov") return "video/quicktime";
  if (ext === "webm") return "video/webm";
  return "video/mp4";
}

function ffprobeSafe(filePath: string) {
  return new Promise<{ duration?: number }>((resolve) => {
    ffmpeg.ffprobe(filePath, (error: Error | undefined, metadata: ffmpeg.FfprobeData) => {
      if (error) {
        resolve({});
        return;
      }
      resolve({ duration: metadata.format?.duration });
    });
  });
}

function trimCopy(inputPath: string, outputPath: string, startSeconds: number, durationSeconds: number) {
  return new Promise<boolean>((resolve) => {
    ffmpeg(inputPath)
      .inputOptions([`-ss ${startSeconds}`])
      .outputOptions([`-t ${durationSeconds}`, "-c copy", "-movflags +faststart"])
      .output(outputPath)
      .on("end", () => resolve(true))
      .on("error", () => resolve(false))
      .run();
  });
}

function trimReencode(inputPath: string, outputPath: string, startSeconds: number, durationSeconds: number) {
  return new Promise<boolean>((resolve) => {
    ffmpeg(inputPath)
      .inputOptions([`-ss ${startSeconds}`])
      .outputOptions([
        `-t ${durationSeconds}`,
        "-movflags +faststart",
        "-c:v libx264",
        "-preset veryfast",
        "-crf 28",
        "-c:a aac",
        "-b:a 128k",
      ])
      .output(outputPath)
      .on("end", () => resolve(true))
      .on("error", () => resolve(false))
      .run();
  });
}

async function hashFile(filePath: string) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}
