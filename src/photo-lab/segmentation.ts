/** Phase B contract. A background confidence map is NEVER a subject alpha matte. */
export type SegmentationRequest = {
  image: ImageBitmap;
  trimap?: ImageData;
  signal: AbortSignal;
};
export type SegmentationResult = {
  alpha: Float32Array;
  shadow: Float32Array;
  width: number;
  height: number;
  uncertain: Uint8Array;
  model: string;
  revision: string;
};
export interface SubjectMattingProvider {
  readonly name: string;
  readonly available: boolean;
  // Returned alpha must preserve hair, sheer fabric and contact shadows; no generated pixels.
  segment(request: SegmentationRequest): Promise<SegmentationResult>;
}
export const unavailableMatting: SubjectMattingProvider = {
  name: "尚未集成精细主体分割 / matting 模型",
  available: false,
  async segment() {
    throw Error(
      "模式 B 尚未安装经过验证的宠物毛发与透明材质 matting 模型。背景候选检测不能替代精细分割。",
    );
  },
};
