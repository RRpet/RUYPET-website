import { processPixels } from "./engine";
import type { Adjustments, Stroke } from "./types";
self.onmessage = (
  event: MessageEvent<{
    pixels: ArrayBuffer;
    width: number;
    height: number;
    params: Adjustments;
    protect: Stroke[];
  }>,
) => {
  try {
    const { pixels, width, height, params, protect } = event.data;
    const result = processPixels(
      new Uint8ClampedArray(pixels),
      width,
      height,
      params,
      protect,
    );
    self.postMessage(
      { result },
      {
        transfer: [
          result.pixels.buffer,
          result.mask.buffer,
          result.protection.buffer,
        ],
      },
    );
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
