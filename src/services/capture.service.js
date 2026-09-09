const { desktopCapturer, screen } = require('electron');
const logger = require('../core/logger').createServiceLogger('CAPTURE');
const roiService = require('./roi.service');

class CaptureService {
  constructor() {
    this.isProcessing = false;
  }

  listDisplays() {
    try {
      const displays = screen.getAllDisplays().map(d => ({
        id: d.id,
        bounds: d.bounds,
        size: d.size,
        scaleFactor: d.scaleFactor,
        rotation: d.rotation,
        touchSupport: d.touchSupport || 'unknown'
      }));
      return { success: true, displays };
    } catch (error) {
      logger.error('Failed to list displays', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Capture screenshot and return an image buffer.
   * options: { displayId?: number, area?: { x, y, width, height }, autoROI?: boolean }
   */
  async captureAndProcess(options = {}) {
    if (this.isProcessing) throw new Error('Capture already in progress');
    this.isProcessing = true;
    const startTime = Date.now();
    try {
      const { image, metadata } = await this.captureScreenshot(options);

      // Crop if area specified or auto-detect ROI
      let finalImage = image;
      let roiMetadata = null;
      if (options.area && this._isValidArea(options.area)) {
        try {
          finalImage = image.crop(options.area);
        } catch (e) {
          logger.warn('Crop failed, returning full image', { error: e.message, area: options.area });
        }
      } else if (options.autoROI !== false) {
        try {
          const rawBitmap = image.toBitmap();
          const { width, height } = image.getSize();
          const roi = roiService.findTextRegion(rawBitmap, width, height, 4);
          if (roi && roi.isCropped) {
            finalImage = image.crop(roi);
            roiMetadata = roi;
            logger.info('Auto-ROI cropped screen to problem region', {
              from: `${width}x${height}`,
              to: `${roi.width}x${roi.height}`
            });
          }
        } catch (e) {
          logger.warn('Auto-ROI detection failed, using full image', { error: e.message });
        }
      }

      // Check dHash deduplication
      let dHash = null;
      let isDuplicate = false;
      try {
        const rawCropBitmap = finalImage.toBitmap();
        const cropSize = finalImage.getSize();
        dHash = roiService.computeDHash(rawCropBitmap, cropSize.width, cropSize.height, 4);
        // Text-heavy screens: threshold 2 (not 6). A missed capture of a
        // newly added constraint is far more costly than a duplicate call.
        isDuplicate = roiService.isDuplicateFrame(dHash, roiService.TEXT_DHASH_THRESHOLD || 2);
      } catch (e) {
        logger.warn('dHash computation failed', { error: e.message });
      }

      const isJpegAvailable = typeof finalImage.toJPEG === 'function';
      const buffer = isJpegAvailable ? finalImage.toJPEG(75) : finalImage.toPNG();
      const mimeType = isJpegAvailable ? 'image/jpeg' : 'image/png';

      logger.logPerformance('Screenshot capture', startTime, {
        bytes: buffer.length,
        dimensions: finalImage.getSize(),
        isCropped: !!roiMetadata,
        isDuplicate
      });

      return {
        imageBuffer: buffer,
        mimeType,
        dHash,
        isDuplicate,
        roi: roiMetadata,
        metadata: {
          timestamp: new Date().toISOString(),
          source: metadata,
          processingTime: Date.now() - startTime
        }
      };
    } finally {
      this.isProcessing = false;
    }
  }

  async captureScreenshot(options = {}) {
    const targetDisplay = this._getTargetDisplay(options.displayId);
    const { width, height } = targetDisplay.size || { width: 1920, height: 1080 };

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height }
    });

    if (sources.length === 0) {
      throw new Error('No screen sources available for capture');
    }

    // Find source matching the target display by comparing sizes as heuristic
    let source = sources[0];
    const match = sources.find(s => {
      const size = s.thumbnail.getSize();
      return size.width === width && size.height === height;
    });
    if (match) source = match;

    const image = source.thumbnail;
    if (!image) throw new Error('Failed to capture screen thumbnail');

    logger.debug('Screenshot captured successfully', {
      sourceName: source.name,
      imageSize: image.getSize()
    });

    return {
      image,
      metadata: {
        displayId: targetDisplay.id,
        sourceName: source.name,
        dimensions: image.getSize(),
        captureTime: new Date().toISOString()
      }
    };
  }

  _getTargetDisplay(displayId) {
    const all = screen.getAllDisplays();
    if (!all || all.length === 0) return screen.getPrimaryDisplay();
    if (displayId == null) return screen.getPrimaryDisplay();
    const found = all.find(d => d.id === displayId);
    return found || screen.getPrimaryDisplay();
  }

  _isValidArea(area) {
    return area && Number.isFinite(area.x) && Number.isFinite(area.y) &&
      Number.isFinite(area.width) && Number.isFinite(area.height) &&
      area.width > 0 && area.height > 0;
  }
}

module.exports = new CaptureService();
