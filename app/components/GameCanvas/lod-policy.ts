export function pickLod(tilePixelSize: number, prev: 0 | 1 | 2 | 3 | 4 | null): 0 | 1 | 2 | 3 | 4 {
  const thresholds = [90, 180, 320, 520];
  const hysteresis = 18;

  if (prev !== null) {
    if (prev > 0 && tilePixelSize < thresholds[prev - 1] - hysteresis) {
      return (prev - 1) as 0 | 1 | 2 | 3 | 4;
    }
    if (prev < 4 && tilePixelSize > thresholds[prev] + hysteresis) {
      return (prev + 1) as 0 | 1 | 2 | 3 | 4;
    }
    return prev;
  }

  if (tilePixelSize < thresholds[0]) return 0;
  if (tilePixelSize < thresholds[1]) return 1;
  if (tilePixelSize < thresholds[2]) return 2;
  if (tilePixelSize < thresholds[3]) return 3;
  return 4;
}
