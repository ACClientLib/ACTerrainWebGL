export type TransparencyTier = "A" | "B" | "C";

export interface TransparencyCapabilities {
  readonly tier: TransparencyTier;
  readonly drawBuffersIndexed: boolean;
  readonly colorBufferFloat: boolean;
  readonly floatBlend: boolean;
}

export interface DepthBucketQueue<T> {
  readonly bucketCount: number;
  readonly counts: Uint32Array;
  readonly offsets: Uint32Array;
  values: Uint32Array;
  clear(): void;
  add(bucket: number, value: number): void;
  finish(): void;
}

export function probeTransparency(gl: WebGL2RenderingContext): TransparencyCapabilities {
  const drawBuffersIndexed = gl.getExtension("OES_draw_buffers_indexed") !== null;
  const colorBufferFloat = gl.getExtension("EXT_color_buffer_float") !== null;
  const floatBlend = gl.getExtension("EXT_float_blend") !== null;
  const framebuffer = gl.createFramebuffer();
  const accumulation = gl.createTexture();
  const revealage = gl.createTexture();
  let complete = false;
  if (framebuffer && accumulation && revealage && colorBufferFloat) {
    gl.bindTexture(gl.TEXTURE_2D, accumulation);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 1, 1, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, revealage);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, 1, 1, 0, gl.RED, gl.HALF_FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, accumulation, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, revealage, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    if (complete) {
      gl.viewport(0, 0, 1, 1);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
      gl.clearBufferfv(gl.COLOR, 1, [1, 1, 1, 1]);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.clear(gl.COLOR_BUFFER_BIT);
      complete = gl.getError() === gl.NO_ERROR;
    }
  }
  if (framebuffer) gl.deleteFramebuffer(framebuffer);
  if (accumulation) gl.deleteTexture(accumulation);
  if (revealage) gl.deleteTexture(revealage);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const tier: TransparencyTier = complete && drawBuffersIndexed && floatBlend ? "A" : complete && floatBlend ? "B" : "C";
  return { tier, drawBuffersIndexed, colorBufferFloat, floatBlend };
}

export function createDepthBucketQueue<T = number>(bucketCount = 16): DepthBucketQueue<T> {
  const counts = new Uint32Array(bucketCount);
  const offsets = new Uint32Array(bucketCount + 1);
  const cursors = new Uint32Array(bucketCount + 1);
  let staging = new Uint32Array(256);
  let stagingBuckets = new Uint32Array(staging.length);
  let values = new Uint32Array(staging.length);
  let length = 0;
  const queue: DepthBucketQueue<T> = {
    bucketCount,
    counts,
    offsets,
    values,
    clear() { counts.fill(0); offsets.fill(0); length = 0; },
    add(bucket, value) {
      if (length === staging.length) {
        const next = new Uint32Array(staging.length * 2);
        const nextBuckets = new Uint32Array(stagingBuckets.length * 2);
        next.set(staging);
        nextBuckets.set(stagingBuckets);
        staging = next;
        stagingBuckets = nextBuckets;
        values = new Uint32Array(staging.length);
        queue.values = values;
      }
      const index = Math.max(0, Math.min(bucketCount - 1, bucket));
      counts[index]++;
      staging[length++] = value;
      stagingBuckets[length - 1] = index;
    },
    finish() {
      offsets[0] = 0;
      for (let i = 0; i < bucketCount; i++) offsets[i + 1] = offsets[i] + counts[i];
      cursors.set(offsets);
      for (let i = 0; i < length; i++) {
        const bucket = stagingBuckets[i];
        values[cursors[bucket]++] = staging[i];
      }
    },
  };
  return queue;
}
