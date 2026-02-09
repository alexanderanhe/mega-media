import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) {
  console.error("Usage: node scripts/generate-branding-icons.mjs <input-svg> <output-dir>");
  process.exit(1);
}

const svg = fs.readFileSync(input);
const iconsDir = path.join(outDir, "icons");
fs.mkdirSync(iconsDir, { recursive: true });

async function writePng(size, dest) {
  await sharp(svg)
    .resize(size, size)
    .png()
    .toFile(dest);
}

await Promise.all([
  writePng(180, path.join(outDir, "apple-touch-icon.png")),
  writePng(192, path.join(iconsDir, "icon-192.png")),
  writePng(512, path.join(iconsDir, "icon-512.png")),
]);

console.log("Generated icons in", outDir);
