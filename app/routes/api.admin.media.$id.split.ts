import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import ffmpeg from "fluent-ffmpeg";
import { getCollections, ObjectId } from "~/server/db";
import { downloadObjectToFile, uploadFileToR2 } from "~/server/r2";
import { ApiError, jsonOk, parseJson, requireRole, withApiErrorHandling } from "~/server/http";
import { splitMediaSchema } from "~/server/schemas";
import { enqueueMediaProcessing } from "~/server/media-processor";

if (process.env.FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}

export const action = async ({ request, params }: { request: Request; params: { id: string } }) =>
  withApiErrorHandling(async () => {
    await requireRole(request, "ADMIN");
    if (!ObjectId.isValid(params.id)) throw new ApiError(400, "Invalid media id");

    const body = await parseJson(request, splitMediaSchema);
    const segments = body.segments ?? [];
    if (!segments.length) throw new ApiError(400, "No split segments provided");

    const { media } = await getCollections();
    const existing = await media.findOne({ _id: new ObjectId(params.id) });
    if (!existing) throw new ApiError(404, "Media not found");
    if (existing.type !== "video") throw new ApiError(400, "Only videos can be split");
    if (existing.status !== "ready") throw new ApiError(409, "Video must be ready to split");
    if (existing.mergeLocked) throw new ApiError(409, "Media is locked for merge");
    if (!existing.r2KeyOriginal) throw new ApiError(400, "Missing original video");
    if (existing.splitParentId) throw new ApiError(409, "Split segments cannot be split again");

    const inputPath = path.join(os.tmpdir(), `${existing._id.toString()}-original`);
    await downloadObjectToFile(existing.r2KeyOriginal, inputPath);

    const probe = await ffprobeSafe(inputPath);
    if (!probe.duration || !Number.isFinite(probe.duration)) {
      await fs.unlink(inputPath).catch(() => undefined);
      throw new ApiError(400, "Unable to read video duration");
    }

    const originalExt = extFromKey(existing.r2KeyOriginal);
    const normalizedSegments = segments
      .map((segment) => {
        const start = Math.max(0, segment.startSeconds);
        const end = Math.min(segment.endSeconds, probe.duration!);
        return { startSeconds: start, endSeconds: end };
      })
      .filter((segment) => segment.endSeconds > segment.startSeconds);

    if (!normalizedSegments.length) {
      await fs.unlink(inputPath).catch(() => undefined);
      throw new ApiError(400, "Invalid split segments");
    }

    for (const segment of normalizedSegments) {
      const length = segment.endSeconds - segment.startSeconds;
      if (length < 6) {
        await fs.unlink(inputPath).catch(() => undefined);
        throw new ApiError(400, "Each split must be at least 6 seconds");
      }
      if (segment.startSeconds >= probe.duration!) {
        await fs.unlink(inputPath).catch(() => undefined);
        throw new ApiError(400, "Split start exceeds duration");
      }
    }

    const orderedSegments = normalizedSegments.sort((a, b) => a.startSeconds - b.startSeconds);
    const groupId = existing.splitGroupId ?? existing._id;
    const now = new Date();
    const items: Array<{ id: string; status: string }> = [];

    for (let index = 0; index < orderedSegments.length; index += 1) {
      const segment = orderedSegments[index];
      const durationSeconds = segment.endSeconds - segment.startSeconds;
      const copyPath = path.join(
        os.tmpdir(),
        `${existing._id.toString()}-split-${index + 1}.${originalExt}`,
      );
      const copyOk = await trimCopy(inputPath, copyPath, segment.startSeconds, durationSeconds);

      let finalPath = copyPath;
      let finalExt = originalExt;

      if (!copyOk) {
        finalExt = "mp4";
        const reencodePath = path.join(
          os.tmpdir(),
          `${existing._id.toString()}-split-${index + 1}-reencode.mp4`,
        );
        const reencodeOk = await trimReencode(inputPath, reencodePath, segment.startSeconds, durationSeconds);
        if (!reencodeOk) {
          await fs.unlink(inputPath).catch(() => undefined);
          await fs.unlink(copyPath).catch(() => undefined);
          throw new ApiError(400, "Unable to split video");
        }
        finalPath = reencodePath;
        await fs.unlink(copyPath).catch(() => undefined);
      }

      const finalSize = (await fs.stat(finalPath)).size;
      const baseHash = await hashFile(finalPath);
      const fileHash = `${baseHash}:${existing._id.toString()}:${segment.startSeconds.toFixed(3)}-${segment.endSeconds.toFixed(3)}`;
      const newId = new ObjectId();
      const finalKey = `media/${newId.toString()}/original.${finalExt}`;
      const contentType = mimeFromExt(finalExt);

      await uploadFileToR2({
        key: finalKey,
        filePath: finalPath,
        contentType,
        cacheControl: "public, max-age=31536000, immutable",
      });

      await media.insertOne({
        _id: newId,
        type: "video",
        visibility: existing.visibility,
        title: `${existing.title ?? "Untitled"} (Split ${index + 1})`,
        description: existing.description ?? "",
        fileHash,
        tags: existing.tags ?? [],
        category: existing.category ?? null,
        createdAt: now,
        dateTaken: existing.dateTaken ?? null,
        dateEffective: existing.dateEffective ?? now,
        location: existing.location ?? null,
        r2KeyOriginal: finalKey,
        originalBytes: finalSize,
        variants: {},
        poster: null,
        preview: null,
        blur: null,
        width: null,
        height: null,
        aspect: 1,
        status: "processing",
        splitGroupId: groupId,
        splitParentId: existing._id,
        splitOrder: index + 1,
        splitStartSeconds: segment.startSeconds,
        splitEndSeconds: segment.endSeconds,
      });

      enqueueMediaProcessing({
        mediaId: newId.toString(),
        localPath: finalPath,
        type: "video",
        mime: contentType,
        extension: finalExt,
        manualDateTaken: existing.dateTaken ?? null,
        placeName: existing.location?.placeName,
      });

      items.push({ id: newId.toString(), status: "processing" });
    }

    await media.updateOne(
      { _id: existing._id },
      {
        $set: { splitGroupId: groupId },
        $inc: { splitChildrenCount: orderedSegments.length },
      },
    );

    await fs.unlink(inputPath).catch(() => undefined);

    return jsonOk({ ok: true, items });
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
