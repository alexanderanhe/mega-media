import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import { getCollections, ObjectId } from "~/server/db";
import { deleteObjects, downloadObjectToFile, uploadBufferToR2 } from "~/server/r2";
import { ApiError, jsonOk, parseJson, requireRole, withApiErrorHandling } from "~/server/http";
import { previewMediaSchema } from "~/server/schemas";

const IMAGE_LODS = [64, 128, 256, 512, 1024] as const;

const BLUR_MAX_SIZE = clampNumber(Number(process.env.BLUR_MAX_SIZE ?? 360), 120, 1024);
const BLUR_SIGMA = clampNumber(Number(process.env.BLUR_SIGMA ?? 16), 4, 40);

if (process.env.FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}

export const action = async ({ request, params }: { request: Request; params: { id: string } }) =>
  withApiErrorHandling(async () => {
    await requireRole(request, "ADMIN");
    if (!ObjectId.isValid(params.id)) throw new ApiError(400, "Invalid media id");

    const body = await parseJson(request, previewMediaSchema);

    const { media } = await getCollections();
    const existing = await media.findOne({ _id: new ObjectId(params.id) });
    if (!existing) throw new ApiError(404, "Media not found");
    if (existing.type !== "video") throw new ApiError(400, "Only videos can update preview");
    if (existing.status !== "ready") throw new ApiError(409, "Video must be ready to update preview");
    if (existing.mergeLocked) throw new ApiError(409, "Media is locked for merge");
    if (!existing.r2KeyOriginal) throw new ApiError(400, "Missing original video");
    if (existing.splitParentId || (existing.splitChildrenCount ?? 0) > 0) {
      throw new ApiError(409, "Preview image is disabled when a video has splits");
    }

    const inputPath = path.join(os.tmpdir(), `${existing._id.toString()}-original`);
    await downloadObjectToFile(existing.r2KeyOriginal, inputPath);

    const probe = await ffprobeSafe(inputPath);
    if (!probe.duration || !Number.isFinite(probe.duration)) {
      await fs.unlink(inputPath).catch(() => undefined);
      throw new ApiError(400, "Unable to read video duration");
    }

    const atSeconds = clampNumber(body.atSeconds, 0, probe.duration);
    const posterPath = path.join(os.tmpdir(), `${existing._id.toString()}-poster-${Date.now()}.jpg`);
    await generatePosterAtTime(inputPath, posterPath, atSeconds);

    const posterBuffer = await fs.readFile(posterPath);
    const posterMeta = await sharp(posterBuffer).metadata();
    const stamp = Date.now();

    const posterKey = `media/${existing._id.toString()}/poster-${stamp}.jpg`;
    await uploadBufferToR2({
      key: posterKey,
      body: posterBuffer,
      contentType: "image/jpeg",
      cacheControl: "public, max-age=31536000, immutable",
    });

    const variants: Record<string, { r2Key: string; w: number; h: number; bytes: number; mime: string }> = {};
    for (let i = 0; i < IMAGE_LODS.length; i += 1) {
      const size = IMAGE_LODS[i];
      const rendered = await sharp(posterBuffer)
        .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true });
      const key = `media/${existing._id.toString()}/lod${i}-${stamp}.webp`;
      await uploadBufferToR2({
        key,
        body: rendered.data,
        contentType: "image/webp",
        cacheControl: "public, max-age=31536000, immutable",
      });
      variants[`lod${i}`] = {
        r2Key: key,
        w: rendered.info.width,
        h: rendered.info.height,
        bytes: rendered.info.size,
        mime: "image/webp",
      };
    }

    const blur = await createBlurVariant(posterBuffer, existing._id.toString(), stamp);

    const nextWidth = posterMeta.width ?? existing.width ?? null;
    const nextHeight = posterMeta.height ?? existing.height ?? null;
    const nextAspect =
      nextWidth && nextHeight ? nextWidth / nextHeight : existing.aspect ?? 1;

    const deleteKeys = [
      ...Object.values(existing.variants ?? {}).map((variant) => variant.r2Key),
      existing.poster?.r2Key,
      existing.blur?.r2Key,
    ].filter(Boolean) as string[];

    await media.updateOne(
      { _id: existing._id },
      {
        $set: {
          variants,
          poster: {
            r2Key: posterKey,
            w: posterMeta.width ?? 1,
            h: posterMeta.height ?? 1,
            mime: "image/jpeg",
          },
          blur,
          width: nextWidth,
          height: nextHeight,
          aspect: nextAspect,
        },
      },
    );

    await deleteObjects(deleteKeys);
    await fs.unlink(inputPath).catch(() => undefined);
    await fs.unlink(posterPath).catch(() => undefined);

    return jsonOk({ ok: true });
  })(request);

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

function generatePosterAtTime(videoPath: string, outputPath: string, atSeconds: number) {
  return new Promise<void>((resolve, reject) => {
    ffmpeg(videoPath)
      .inputOptions([`-ss ${atSeconds}`])
      .frames(1)
      .outputOptions(["-q:v 2"])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });
}

async function createBlurVariant(buffer: Buffer, mediaId: string, stamp: number) {
  try {
    const rendered = await sharp(buffer)
      .rotate()
      .resize({ width: BLUR_MAX_SIZE, height: BLUR_MAX_SIZE, fit: "inside", withoutEnlargement: true })
      .blur(BLUR_SIGMA)
      .modulate({ saturation: 0.85 })
      .webp({ quality: 55 })
      .toBuffer({ resolveWithObject: true });

    const key = `media/${mediaId}/blur-${stamp}.webp`;
    await uploadBufferToR2({
      key,
      body: rendered.data,
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
    });

    return {
      r2Key: key,
      w: rendered.info.width ?? 1,
      h: rendered.info.height ?? 1,
      mime: "image/webp",
    };
  } catch {
    return null;
  }
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
