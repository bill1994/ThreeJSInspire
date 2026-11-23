// Both island generators use the same RG8 encoding. Zero-filled atlas
// tiles represent open ocean, including while an island is streaming in.
export const COAST_MAP = { offshore: 45, inland: 12, bottom: -12, top: 4 } as const;

function byte(value: number) {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

export function encodeShore(distanceInland: number) {
  return byte((distanceInland + COAST_MAP.offshore) / (COAST_MAP.offshore + COAST_MAP.inland));
}

export function encodeBed(height: number) {
  return byte((height - COAST_MAP.bottom) / (COAST_MAP.top - COAST_MAP.bottom));
}
