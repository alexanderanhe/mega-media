declare module "heic-convert" {
  type HeicConvertInput = {
    buffer: Buffer | Uint8Array;
    format: "JPEG" | "PNG";
    quality?: number;
  };

  type HeicConvert = (input: HeicConvertInput) => Promise<Uint8Array>;

  const convert: HeicConvert;
  export default convert;
}
