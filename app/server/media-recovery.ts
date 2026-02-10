import path from "node:path";
import os from "node:os";
import { getCollections } from "./db";
import { downloadObjectToFile } from "./r2";
import { enqueueMediaProcessing } from "./media-processor";

let started = false;

export function scheduleProcessingRecovery() {
  if (started) return;
  started = true;
  void recoverProcessingMedia();
}

async function recoverProcessingMedia() {
  try {
    const { media } = await getCollections();
    const stuck = await media.find({ status: "processing" }).toArray();
    for (const item of stuck) {
      if (!item.r2KeyOriginal) {
        await media.updateOne(
          { _id: item._id },
          { $set: { status: "error", errorMessage: "Missing original file for recovery" } },
        );
        continue;
      }
      const extension = item.r2KeyOriginal.split(".").pop() || (item.type === "video" ? "mp4" : "jpg");
      const mime = resolveMime(item.type, extension);
      const tmpPath = path.join(os.tmpdir(), `${item._id.toString()}-recover`);
      try {
        await downloadObjectToFile(item.r2KeyOriginal, tmpPath);
        enqueueMediaProcessing({
          mediaId: item._id.toString(),
          localPath: tmpPath,
          type: item.type,
          mime,
          extension,
        });
      } catch (error) {
        await media.updateOne(
          { _id: item._id },
          { $set: { status: "error", errorMessage: "Recovery failed" } },
        );
      }
    }
  } catch {
    // swallow to avoid crashing on boot
  }
}

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
