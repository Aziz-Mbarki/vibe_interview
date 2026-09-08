/**
 * ROI Service: Content-region detection & perceptual dHash deduplication.
 * Eliminates IDE chrome, wallpapers, dock, and webcam tiles by cropping to the problem,
 * and skips re-sending unchanged screens.
 */

class ROIService {
  constructor() {
    this.lastHash = null;
  }

  /**
   * Find the dense text / problem region from raw image pixels.
   * Pure JS, ~15ms execution time, zero external dependencies.
   *
   * @param {Buffer|Uint8Array} pixelBuffer - Raw image pixels (RGBA or BGRA)
   * @param {number} width - Original image width
   * @param {number} height - Original image height
   * @param {number} [channels=4] - Bytes per pixel (typically 4 for BGRA/RGBA)
   * @returns {{ x: number, y: number, width: number, height: number, isCropped: boolean }}
   */
  findTextRegion(pixelBuffer, width, height, channels = 4) {
    if (!pixelBuffer || width <= 0 || height <= 0) {
      return { x: 0, y: 0, width, height, isCropped: false };
    }

    // Target downscale width: ~320px
    const targetW = Math.min(320, width);
    const scale = width / targetW;
    const targetH = Math.max(1, Math.round(height / scale));

    // 1. Downscale to grayscale buffer
    const gray = new Uint8Array(targetW * targetH);
    for (let gy = 0; gy < targetH; gy++) {
      const origY = Math.min(height - 1, Math.floor(gy * scale));
      for (let gx = 0; gx < targetW; gx++) {
        const origX = Math.min(width - 1, Math.floor(gx * scale));
        const idx = (origY * width + origX) * channels;
        // Standard luma: 0.299 R + 0.587 G + 0.114 B (BGRA or RGBA order is close enough)
        const b0 = pixelBuffer[idx] || 0;
        const b1 = pixelBuffer[idx + 1] || 0;
        const b2 = pixelBuffer[idx + 2] || 0;
        gray[gy * targetW + gx] = Math.round(0.299 * b2 + 0.587 * b1 + 0.114 * b0);
      }
    }

    // 2. Local contrast: divide into 8x8 blocks and calculate standard deviation
    const blockSize = 8;
    const blocksX = Math.floor(targetW / blockSize);
    const blocksY = Math.floor(targetH / blockSize);
    if (blocksX <= 0 || blocksY <= 0) {
      return { x: 0, y: 0, width, height, isCropped: false };
    }

    const inkyGrid = new Uint8Array(blocksX * blocksY);
    const CONTRAST_THRESHOLD = 18; // Stddev threshold for text/code presence

    for (let by = 0; by < blocksY; by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        let sum = 0;
        let count = 0;
        const startX = bx * blockSize;
        const startY = by * blockSize;

        for (let y = 0; y < blockSize; y++) {
          const rowOffset = (startY + y) * targetW;
          for (let x = 0; x < blockSize; x++) {
            sum += gray[rowOffset + (startX + x)];
            count++;
          }
        }
        const mean = sum / count;

        let varianceSum = 0;
        for (let y = 0; y < blockSize; y++) {
          const rowOffset = (startY + y) * targetW;
          for (let x = 0; x < blockSize; x++) {
            const diff = gray[rowOffset + (startX + x)] - mean;
            varianceSum += diff * diff;
          }
        }
        const stddev = Math.sqrt(varianceSum / count);
        if (stddev > CONTRAST_THRESHOLD) {
          inkyGrid[by * blocksX + bx] = 1;
        }
      }
    }

    // 3. Row and column projections
    const rowCounts = new Int32Array(blocksY);
    const colCounts = new Int32Array(blocksX);

    for (let by = 0; by < blocksY; by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        if (inkyGrid[by * blocksX + bx]) {
          rowCounts[by]++;
          colCounts[bx]++;
        }
      }
    }

    // Find bounding bands where inky cells exceed 10% of row/col length
    let minBy = 0;
    let maxBy = blocksY - 1;
    let minBx = 0;
    let maxBx = blocksX - 1;

    const rowThreshold = Math.max(1, Math.round(blocksX * 0.08));
    const colThreshold = Math.max(1, Math.round(blocksY * 0.08));

    while (minBy < blocksY && rowCounts[minBy] < rowThreshold) minBy++;
    while (maxBy > minBy && rowCounts[maxBy] < rowThreshold) maxBy--;
    while (minBx < blocksX && colCounts[minBx] < colThreshold) minBx++;
    while (maxBx > minBx && colCounts[maxBx] < colThreshold) maxBx--;

    if (minBy >= maxBy || minBx >= maxBx) {
      return { x: 0, y: 0, width, height, isCropped: false };
    }

    // Convert back to original coordinates
    const PAD = 24;
    const rawX = Math.max(0, Math.floor(minBx * blockSize * scale) - PAD);
    const rawY = Math.max(0, Math.floor(minBy * blockSize * scale) - PAD);
    const rawMaxX = Math.min(width, Math.ceil((maxBx + 1) * blockSize * scale) + PAD);
    const rawMaxY = Math.min(height, Math.ceil((maxBy + 1) * blockSize * scale) + PAD);

    const cropW = Math.max(1, rawMaxX - rawX);
    const cropH = Math.max(1, rawMaxY - rawY);

    const cropArea = cropW * cropH;
    const fullArea = width * height;
    const areaRatio = cropArea / fullArea;

    // Fall back to full frame if detected region is <15% or >90% of screen
    if (areaRatio < 0.15 || areaRatio > 0.90) {
      return { x: 0, y: 0, width, height, isCropped: false };
    }

    return {
      x: rawX,
      y: rawY,
      width: cropW,
      height: cropH,
      isCropped: true
    };
  }

  /**
   * Compute 64-bit difference hash (dHash) from downscaled image.
   * @param {Buffer|Uint8Array} pixelBuffer - Raw image pixels (RGBA/BGRA)
   * @param {number} width
   * @param {number} height
   * @param {number} [channels=4]
   * @returns {string} 64-bit binary string (e.g. '101001...')
   */
  computeDHash(pixelBuffer, width, height, channels = 4) {
    if (!pixelBuffer || width <= 0 || height <= 0) return '0'.repeat(64);

    // Downscale to 9 columns x 8 rows grayscale
    const dW = 9;
    const dH = 8;
    const gray = new Uint8Array(dW * dH);
    const scaleX = width / dW;
    const scaleY = height / dH;

    for (let gy = 0; gy < dH; gy++) {
      const origY = Math.min(height - 1, Math.floor(gy * scaleY));
      for (let gx = 0; gx < dW; gx++) {
        const origX = Math.min(width - 1, Math.floor(gx * scaleX));
        const idx = (origY * width + origX) * channels;
        const b0 = pixelBuffer[idx] || 0;
        const b1 = pixelBuffer[idx + 1] || 0;
        const b2 = pixelBuffer[idx + 2] || 0;
        gray[gy * dW + gx] = Math.round(0.299 * b2 + 0.587 * b1 + 0.114 * b0);
      }
    }

    // Compare adjacent horizontal pixels
    let hash = '';
    for (let y = 0; y < dH; y++) {
      const rowOffset = y * dW;
      for (let x = 0; x < 8; x++) {
        hash += (gray[rowOffset + x] > gray[rowOffset + x + 1]) ? '1' : '0';
      }
    }

    return hash;
  }

  /**
   * Calculate Hamming distance between two 64-bit binary strings.
   * @param {string} hash1
   * @param {string} hash2
   * @returns {number} Count of differing bits (0 - 64)
   */
  hammingDistance(hash1, hash2) {
    if (!hash1 || !hash2 || hash1.length !== hash2.length) return 64;
    let dist = 0;
    for (let i = 0; i < hash1.length; i++) {
      if (hash1[i] !== hash2[i]) dist++;
    }
    return dist;
  }

  /**
   * Check if current frame is a duplicate of the previous frame.
   * If Hamming distance < 6, considers frame duplicate.
   * Updates internal lastHash when a non-duplicate is received.
   * @param {string} currentHash
   * @param {number} [threshold=6]
   * @returns {boolean} true if duplicate
   */
  isDuplicateFrame(currentHash, threshold = 6) {
    if (!this.lastHash) {
      this.lastHash = currentHash;
      return false;
    }
    const dist = this.hammingDistance(this.lastHash, currentHash);
    if (dist < threshold) {
      return true;
    }
    this.lastHash = currentHash;
    return false;
  }

  resetHash() {
    this.lastHash = null;
  }
}

module.exports = new ROIService();
