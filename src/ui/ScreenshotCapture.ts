export interface ScreenshotResult {
  filename: string;
  copiedToClipboard: boolean;
  savedToFile: boolean;
}

const FONT_STACK = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const SPEED_ARC_LEN = 326.73;
const PUMP_ARC_LEN = 263.2;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatTimestamp(date = new Date()): string {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
    '-',
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join('');
}

function isRectVisible(el: HTMLElement | null): DOMRect | null {
  if (!el) return null;
  if (el.classList.contains('hidden')) return null;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return null;
  const opacity = parseFloat(style.opacity || '1');
  if (!Number.isFinite(opacity) || opacity <= 0.02) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function triggerDownload(blob: Blob, filename: string): boolean {
  try {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Instant, zero-dependency screenshot compositor:
 * Composites the live WebGL frame + active gameplay HUD overlays at full native DPR resolution,
 * saves a timestamped PNG immediately, and writes the PNG to the clipboard when supported.
 */
export class ScreenshotCapture {
  private readonly outCanvas: HTMLCanvasElement;
  private readonly outCtx: CanvasRenderingContext2D;
  private readonly compassScratch: HTMLCanvasElement;
  private readonly compassScratchCtx: CanvasRenderingContext2D;
  private readonly flashEl = document.getElementById('shutter-flash');
  private flashTimeout: number | null = null;
  private lastCaptureAt = 0;

  constructor() {
    this.outCanvas = document.createElement('canvas');
    const ctx = this.outCanvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not initialize 2D context for screenshot capture');
    }
    this.outCtx = ctx;

    this.compassScratch = document.createElement('canvas');
    const cCtx = this.compassScratch.getContext('2d');
    if (!cCtx) {
      throw new Error('Could not initialize 2D context for compass compositing');
    }
    this.compassScratchCtx = cCtx;
  }

  public canCapture(cooldownMs = 350): boolean {
    return performance.now() - this.lastCaptureAt >= cooldownMs;
  }

  /**
   * Captures the current WebGL canvas + live HUD overlays synchronously so callers can
   * invoke this right after `renderer.render(...)` and inside a `keydown` user gesture.
   */
  public capture(webglCanvas: HTMLCanvasElement): Promise<ScreenshotResult> {
    this.lastCaptureAt = performance.now();

    const outW = Math.max(1, webglCanvas.width);
    const outH = Math.max(1, webglCanvas.height);
    if (this.outCanvas.width !== outW || this.outCanvas.height !== outH) {
      this.outCanvas.width = outW;
      this.outCanvas.height = outH;
    }

    const ctx = this.outCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, outW, outH);

    // 1. Base WebGL 3D scene at full native pixel resolution
    ctx.drawImage(webglCanvas, 0, 0, outW, outH);

    // 2. Composite live HUD in CSS-pixel coordinates scaled cleanly to native backing resolution
    const cssW = Math.max(1, window.innerWidth);
    const cssH = Math.max(1, window.innerHeight);
    ctx.save();
    ctx.scale(outW / cssW, outH / cssH);
    this.drawVignettes(ctx, cssW, cssH);
    this.drawTopLeftHud(ctx);
    this.drawTopCenterHud(ctx);
    this.drawTopRightHud(ctx);
    this.drawCenterBanners(ctx);
    this.drawBottomRightTelemetry(ctx);
    ctx.restore();

    // 3. Fire subtle visual shutter flash AFTER capture so the frame stays crisp
    this.triggerShutterFlash();

    const filename = `apex-goat-${formatTimestamp()}.png`;

    // 4. Encode PNG asynchronously off the render frame
    const blobPromise = new Promise<Blob>((resolve, reject) => {
      this.outCanvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('PNG encoding failed'));
        }
      }, 'image/png');
    });

    // 5. Kick off clipboard write SYNCHRONOUSLY while transient user activation is still active
    let clipboardPromise: Promise<boolean> = Promise.resolve(false);
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.write === 'function' &&
      typeof ClipboardItem !== 'undefined'
    ) {
      try {
        const item = new ClipboardItem({ 'image/png': blobPromise });
        clipboardPromise = navigator.clipboard
          .write([item])
          .then(() => true)
          .catch(() => false);
      } catch {
        clipboardPromise = Promise.resolve(false);
      }
    }

    // 6. Trigger immediate file download once PNG bytes are ready
    const downloadPromise = blobPromise
      .then((blob) => triggerDownload(blob, filename))
      .catch(() => false);

    return Promise.all([downloadPromise, clipboardPromise]).then(
      ([savedToFile, copiedToClipboard]) => ({
        filename,
        copiedToClipboard,
        savedToFile,
      }),
    );
  }

  private triggerShutterFlash(): void {
    if (!this.flashEl) return;
    if (this.flashTimeout !== null) {
      window.clearTimeout(this.flashTimeout);
    }
    this.flashEl.classList.remove('active');
    // Force reflow so rapid consecutive snaps re-trigger the flash animation cleanly
    void this.flashEl.offsetWidth;
    this.flashEl.classList.add('active');
    this.flashTimeout = window.setTimeout(() => {
      this.flashEl?.classList.remove('active');
      this.flashTimeout = null;
    }, 220);
  }

  private drawVignettes(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const cx = w * 0.5;
    const cy = h * 0.5;
    const maxR = Math.hypot(cx, cy);

    const lensEl = document.getElementById('lens-overlay');
    if (lensEl) {
      const lensOpacity = parseFloat(window.getComputedStyle(lensEl).opacity || '0');
      if (lensOpacity > 0.01) {
        ctx.save();
        ctx.globalAlpha = lensOpacity;
        const grad = ctx.createRadialGradient(cx, cy, maxR * 0.58, cx, cy, maxR);
        grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
        grad.addColorStop(0.68, 'rgba(0, 0, 0, 0.22)');
        grad.addColorStop(1, 'rgba(0, 0, 0, 0.52)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
    }

    const speedVigEl = document.getElementById('speed-vignette');
    if (speedVigEl) {
      const vigOpacity = parseFloat(window.getComputedStyle(speedVigEl).opacity || '0');
      if (vigOpacity > 0.01) {
        ctx.save();
        ctx.globalAlpha = vigOpacity;
        const grad = ctx.createRadialGradient(cx, cy, maxR * 0.52, cx, cy, maxR);
        grad.addColorStop(0, 'rgba(255, 255, 255, 0)');
        grad.addColorStop(0.72, 'rgba(190, 230, 255, 0.14)');
        grad.addColorStop(1, 'rgba(255, 255, 255, 0.28)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
    }
  }

  private drawTopLeftHud(ctx: CanvasRenderingContext2D): void {
    const recEl = document.querySelector<HTMLElement>('.gopro-rec');
    const camLabelEl = document.getElementById('cam-label');
    const recRect = isRectVisible(recEl);
    if (recRect && camLabelEl) {
      const dotEl = recEl?.querySelector<HTMLElement>('.rec-dot') ?? null;
      const dotRect = dotEl ? dotEl.getBoundingClientRect() : null;
      if (dotRect && dotRect.width > 0) {
        ctx.save();
        ctx.fillStyle = '#ff3b30';
        ctx.shadowColor = '#ff3b30';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(
          dotRect.left + dotRect.width * 0.5,
          dotRect.top + dotRect.height * 0.5,
          dotRect.width * 0.5,
          0,
          Math.PI * 2,
        );
        ctx.fill();
        ctx.restore();
      }

      const labelRect = camLabelEl.getBoundingClientRect();
      ctx.save();
      ctx.font = `800 11px ${FONT_STACK}`;
      ctx.fillStyle = 'rgba(246, 250, 255, 0.94)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.78)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 1;
      ctx.fillText(
        (camLabelEl.textContent ?? '').toUpperCase(),
        labelRect.left,
        labelRect.top + labelRect.height * 0.5,
      );
      ctx.restore();
    }

    // Course minimap + elevation card
    const mapCard = document.getElementById('course-map-card');
    const mapRect = isRectVisible(mapCard);
    if (mapRect && mapCard) {
      const headSpan = mapCard.querySelector<HTMLElement>('.course-map-head span');
      if (headSpan) {
        const r = headSpan.getBoundingClientRect();
        ctx.save();
        ctx.font = `800 9px ${FONT_STACK}`;
        ctx.fillStyle = 'rgba(235, 245, 255, 0.86)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 1;
        ctx.fillText((headSpan.textContent ?? '').toUpperCase(), r.left, r.top + r.height * 0.5);
        ctx.restore();
      }

      const minimapCanvas = document.getElementById('minimap-canvas') as HTMLCanvasElement | null;
      const miniRect = isRectVisible(minimapCanvas);
      if (minimapCanvas && miniRect && minimapCanvas.width > 0 && minimapCanvas.height > 0) {
        ctx.drawImage(minimapCanvas, miniRect.left, miniRect.top, miniRect.width, miniRect.height);
      }

      const divider = mapCard.querySelector<HTMLElement>('.course-map-divider');
      if (divider) {
        const dRect = divider.getBoundingClientRect();
        const grad = ctx.createLinearGradient(dRect.left, 0, dRect.right, 0);
        grad.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
        grad.addColorStop(0.75, 'rgba(255, 255, 255, 0.04)');
        grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(dRect.left, dRect.top, dRect.width, Math.max(1, dRect.height));
      }

      const elevCanvas = document.getElementById('elev-canvas') as HTMLCanvasElement | null;
      const elevRect = isRectVisible(elevCanvas);
      if (elevCanvas && elevRect && elevCanvas.width > 0 && elevCanvas.height > 0) {
        ctx.drawImage(elevCanvas, elevRect.left, elevRect.top, elevRect.width, elevRect.height);
      }

      const legendItems = mapCard.querySelectorAll<HTMLElement>('.legend-item');
      legendItems.forEach((item) => {
        const iRect = isRectVisible(item);
        if (!iRect) return;
        const dot = item.querySelector<HTMLElement>('.legend-dot');
        if (dot) {
          const dRect = dot.getBoundingClientRect();
          const dotColor = window.getComputedStyle(dot).backgroundColor || '#ffffff';
          ctx.save();
          ctx.fillStyle = dotColor;
          ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
          ctx.shadowBlur = 5;
          ctx.beginPath();
          ctx.arc(
            dRect.left + dRect.width * 0.5,
            dRect.top + dRect.height * 0.5,
            dRect.width * 0.5,
            0,
            Math.PI * 2,
          );
          ctx.fill();
          ctx.restore();
        }
        ctx.save();
        ctx.font = `800 8.5px ${FONT_STACK}`;
        ctx.fillStyle = 'rgba(235, 245, 255, 0.84)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.92)';
        ctx.shadowBlur = 7;
        ctx.shadowOffsetY = 1;
        const textX = dot ? dot.getBoundingClientRect().right + 4 : iRect.left;
        ctx.fillText(
          (item.textContent ?? '').trim().toUpperCase(),
          textX,
          iRect.top + iRect.height * 0.5,
        );
        ctx.restore();
      });
    }
  }

  private drawTopCenterHud(ctx: CanvasRenderingContext2D): void {
    // Horizon compass canvas with soft horizontal edge fade matching CSS mask-image
    const compassCanvas = document.getElementById('horizon-compass') as HTMLCanvasElement | null;
    const compassRect = isRectVisible(compassCanvas);
    if (compassCanvas && compassRect && compassCanvas.width > 0 && compassCanvas.height > 0) {
      if (
        this.compassScratch.width !== compassCanvas.width ||
        this.compassScratch.height !== compassCanvas.height
      ) {
        this.compassScratch.width = compassCanvas.width;
        this.compassScratch.height = compassCanvas.height;
      }
      const cCtx = this.compassScratchCtx;
      cCtx.setTransform(1, 0, 0, 1, 0, 0);
      cCtx.clearRect(0, 0, compassCanvas.width, compassCanvas.height);
      cCtx.drawImage(compassCanvas, 0, 0);
      cCtx.globalCompositeOperation = 'destination-in';
      const fadeGrad = cCtx.createLinearGradient(0, 0, compassCanvas.width, 0);
      fadeGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      fadeGrad.addColorStop(0.16, 'rgba(0, 0, 0, 1)');
      fadeGrad.addColorStop(0.84, 'rgba(0, 0, 0, 1)');
      fadeGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      cCtx.fillStyle = fadeGrad;
      cCtx.fillRect(0, 0, compassCanvas.width, compassCanvas.height);
      cCtx.globalCompositeOperation = 'source-over';

      ctx.drawImage(
        this.compassScratch,
        compassRect.left,
        compassRect.top,
        compassRect.width,
        compassRect.height,
      );
    }

    // Main timer readout
    const timerEl = document.getElementById('timer-display');
    const timerRect = isRectVisible(timerEl);
    if (timerEl && timerRect) {
      const style = window.getComputedStyle(timerEl);
      ctx.save();
      ctx.font = `900 ${style.fontSize || '38px'} ${FONT_STACK}`;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.74)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 2;
      ctx.fillText(
        timerEl.textContent ?? '',
        timerRect.left + timerRect.width * 0.5,
        timerRect.top + timerRect.height * 0.52,
      );
      ctx.restore();
    }

    // Timer meta (CP / ALT / DROP)
    const metaEl = document.querySelector<HTMLElement>('.timer-meta');
    const metaRect = isRectVisible(metaEl);
    if (metaEl && metaRect) {
      const cp = document.getElementById('cp-display')?.textContent ?? '';
      const alt = document.getElementById('alt-display')?.textContent ?? '';
      const drop = document.getElementById('drop-display')?.textContent ?? '';
      const text = [cp, alt, drop].filter(Boolean).join(' · ').toUpperCase();
      const style = window.getComputedStyle(metaEl);
      ctx.save();
      ctx.font = `800 ${style.fontSize || '11px'} ${FONT_STACK}`;
      ctx.fillStyle = 'rgba(242, 248, 255, 0.92)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.82)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 1;
      ctx.fillText(
        text,
        metaRect.left + metaRect.width * 0.5,
        metaRect.top + metaRect.height * 0.5,
      );
      ctx.restore();
    }

    // Split delta
    const deltaEl = document.getElementById('split-delta');
    const deltaRect = isRectVisible(deltaEl);
    const deltaText = (deltaEl?.textContent ?? '').trim();
    if (deltaEl && deltaRect && deltaText) {
      const style = window.getComputedStyle(deltaEl);
      ctx.save();
      ctx.font = `900 ${style.fontSize || '15px'} ${FONT_STACK}`;
      ctx.fillStyle = style.color || '#36e692';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 2;
      ctx.fillText(
        deltaText,
        deltaRect.left + deltaRect.width * 0.5,
        deltaRect.top + deltaRect.height * 0.5,
      );
      ctx.restore();
    }

    // Mobile compact elevation strip (if visible on narrow screens)
    const mobileElev = document.getElementById('mobile-elev-canvas') as HTMLCanvasElement | null;
    const mobileElevRect = isRectVisible(mobileElev);
    if (mobileElev && mobileElevRect && mobileElev.width > 0 && mobileElev.height > 0) {
      ctx.drawImage(
        mobileElev,
        mobileElevRect.left,
        mobileElevRect.top,
        mobileElevRect.width,
        mobileElevRect.height,
      );
    }

    // Combo pill
    const comboWrap = document.getElementById('combo-wrap');
    const comboPill = document.getElementById('combo-pill');
    if (comboWrap?.classList.contains('visible') && comboPill) {
      const pRect = isRectVisible(comboPill);
      if (pRect) {
        const pStyle = window.getComputedStyle(comboPill);
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.34)';
        ctx.shadowBlur = 20;
        ctx.shadowOffsetY = 6;
        drawRoundedRect(ctx, pRect.left, pRect.top, pRect.width, pRect.height, 12);
        ctx.fillStyle = 'rgba(10, 16, 28, 0.62)';
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = pStyle.borderColor || 'rgba(255, 212, 71, 0.42)';
        ctx.lineWidth = 1;
        ctx.stroke();

        const multEl = document.getElementById('combo-mult');
        const ptsEl = document.getElementById('combo-pts');
        const totalEl = document.getElementById('combo-total');
        const drawInline = (el: HTMLElement | null, weight: number, fallbackSize: string) => {
          if (!el) return;
          const txt = (el.textContent ?? '').trim();
          if (!txt) return;
          const r = el.getBoundingClientRect();
          if (r.width <= 0) return;
          const s = window.getComputedStyle(el);
          ctx.font = `${weight} ${s.fontSize || fallbackSize} ${FONT_STACK}`;
          ctx.fillStyle = s.color || '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(txt, r.left + r.width * 0.5, r.top + r.height * 0.5);
        };
        drawInline(multEl, 900, '18px');
        drawInline(ptsEl, 800, '15px');
        drawInline(totalEl, 700, '10px');

        const chainEl = document.getElementById('combo-chain');
        const chainText = (chainEl?.textContent ?? '').trim();
        if (chainEl && chainText) {
          const r = chainEl.getBoundingClientRect();
          ctx.font = `700 10px ${FONT_STACK}`;
          ctx.fillStyle = '#7ef2ff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(chainText.toUpperCase(), r.left + r.width * 0.5, r.top + r.height * 0.5);
        }

        const barTrack = comboPill.querySelector<HTMLElement>('.combo-bar');
        const barFill = document.getElementById('combo-bar-fill');
        if (barTrack && barFill) {
          const tRect = barTrack.getBoundingClientRect();
          const fRect = barFill.getBoundingClientRect();
          drawRoundedRect(ctx, tRect.left, tRect.top, tRect.width, tRect.height, 4);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
          ctx.fill();
          if (fRect.width > 0.5) {
            const grad = ctx.createLinearGradient(tRect.left, 0, tRect.right, 0);
            grad.addColorStop(0, '#5ff3ff');
            grad.addColorStop(0.5, '#ffd447');
            grad.addColorStop(1, '#47ff9c');
            drawRoundedRect(ctx, fRect.left, fRect.top, fRect.width, fRect.height, 4);
            ctx.fillStyle = grad;
            ctx.fill();
          }
        }
        ctx.restore();
      }
    }
  }

  private drawTopRightHud(ctx: CanvasRenderingContext2D): void {
    // Scene badge pill (e.g., MORNING · 08:30) — trimmed tightly around the text without the hotkey badge
    const scenePill = document.getElementById('scene-pill');
    const sceneTextEl = document.getElementById('scene-pill-text');
    const sceneRect = isRectVisible(scenePill);
    if (scenePill && sceneTextEl && sceneRect) {
      const label = (sceneTextEl.textContent ?? '').toUpperCase();
      ctx.save();
      ctx.font = `800 10.5px ${FONT_STACK}`;
      const padX = 11;
      const pillW = Math.min(sceneRect.width, ctx.measureText(label).width + padX * 2);
      const pillLeft = sceneRect.right - pillW;

      drawRoundedRect(
        ctx,
        pillLeft,
        sceneRect.top,
        pillW,
        sceneRect.height,
        sceneRect.height * 0.5,
      );
      ctx.fillStyle = 'rgba(10, 18, 30, 0.48)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = '#f4f9ff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
      ctx.shadowBlur = 6;
      ctx.fillText(label, pillLeft + pillW * 0.5, sceneRect.top + sceneRect.height * 0.5);
      ctx.restore();
    }

    // PB & Medal target line
    const pbLine = document.querySelector<HTMLElement>('.hud-pb-line');
    const pbLineRect = isRectVisible(pbLine);
    if (pbLine && pbLineRect) {
      const pbVal = document.getElementById('m-pb')?.textContent ?? '--:--.--';
      const medalEl = document.getElementById('next-medal-target');
      const medalText = (medalEl?.textContent ?? '').toUpperCase();
      const medalColor = medalEl ? window.getComputedStyle(medalEl).color : '#ffd447';
      const rightX = pbLineRect.right;
      const midY = pbLineRect.top + pbLineRect.height * 0.5;

      ctx.save();
      ctx.font = `800 11px ${FONT_STACK}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 1;

      ctx.fillStyle = medalColor;
      ctx.fillText(medalText, rightX, midY);
      const medalW = ctx.measureText(medalText).width;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.fillText(' · ', rightX - medalW, midY);
      const dotW = ctx.measureText(' · ').width;

      ctx.fillStyle = '#84d2ff';
      ctx.fillText(`PB ${pbVal}`, rightX - medalW - dotW, midY);
      ctx.restore();
    }
  }

  private drawCenterBanners(ctx: CanvasRenderingContext2D): void {
    // Crimson Alpine Hazard Warning banner
    const hazardWarn = document.getElementById('hazard-warning');
    if (hazardWarn?.classList.contains('visible')) {
      const r = isRectVisible(hazardWarn);
      if (r) {
        const titleEl = document.getElementById('hazard-warn-title');
        const subEl = document.getElementById('hazard-warn-sub');
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.42)';
        ctx.shadowBlur = 24;
        ctx.shadowOffsetY = 8;
        drawRoundedRect(ctx, r.left, r.top, r.width, r.height, 14);
        ctx.fillStyle = 'rgba(34, 10, 14, 0.78)';
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = 'rgba(255, 96, 96, 0.85)';
        ctx.lineWidth = 1;
        ctx.stroke();

        if (titleEl) {
          const tr = titleEl.getBoundingClientRect();
          ctx.font = `900 13px ${FONT_STACK}`;
          ctx.fillStyle = '#ff9c9c';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(
            (titleEl.textContent ?? '').toUpperCase(),
            tr.left + tr.width * 0.5,
            tr.top + tr.height * 0.5,
          );
        }
        if (subEl) {
          const sr = subEl.getBoundingClientRect();
          ctx.font = `700 10.5px ${FONT_STACK}`;
          ctx.fillStyle = 'rgba(255, 236, 236, 0.94)';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(
            (subEl.textContent ?? '').toUpperCase(),
            sr.left + sr.width * 0.5,
            sr.top + sr.height * 0.5,
          );
        }
        ctx.restore();
      }
    }

    // Center action / trick / checkpoint banner (APEX BLEAT!, WALL KICK!, CHECKPOINT)
    const banner = document.getElementById('center-banner');
    if (banner?.classList.contains('visible')) {
      const r = isRectVisible(banner);
      if (r) {
        const titleEl = document.getElementById('banner-title');
        const subEl = document.getElementById('banner-sub');
        ctx.save();
        if (titleEl) {
          const tr = titleEl.getBoundingClientRect();
          const ts = window.getComputedStyle(titleEl);
          ctx.font = `900 ${ts.fontSize || '38px'} ${FONT_STACK}`;
          ctx.fillStyle = ts.color || '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.shadowColor = 'rgba(0, 0, 0, 0.72)';
          ctx.shadowBlur = 20;
          ctx.shadowOffsetY = 4;
          ctx.fillText(
            (titleEl.textContent ?? '').toUpperCase(),
            tr.left + tr.width * 0.5,
            tr.top + tr.height * 0.5,
          );
        }
        if (subEl && (subEl.textContent ?? '').trim()) {
          const sr = subEl.getBoundingClientRect();
          const ss = window.getComputedStyle(subEl);
          ctx.font = `700 ${ss.fontSize || '14px'} ${FONT_STACK}`;
          ctx.fillStyle = ss.color || '#cfe8ff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
          ctx.shadowBlur = 10;
          ctx.shadowOffsetY = 2;
          ctx.fillText(
            (subEl.textContent ?? '').toUpperCase(),
            sr.left + sr.width * 0.5,
            sr.top + sr.height * 0.5,
          );
        }
        ctx.restore();
      }
    }

    // Wipeout toast (if mid-crash)
    const wipeout = document.getElementById('wipeout-toast');
    if (wipeout?.classList.contains('visible')) {
      const r = isRectVisible(wipeout);
      if (r) {
        const titleEl = document.getElementById('wipeout-title');
        const subEl = document.getElementById('wipeout-sub');
        ctx.save();
        drawRoundedRect(ctx, r.left, r.top, r.width, r.height, 14);
        ctx.fillStyle = 'rgba(20, 8, 12, 0.82)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 92, 92, 0.72)';
        ctx.lineWidth = 1;
        ctx.stroke();

        if (titleEl) {
          const tr = titleEl.getBoundingClientRect();
          ctx.font = `900 15px ${FONT_STACK}`;
          ctx.fillStyle = '#ff9898';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(
            (titleEl.textContent ?? '').toUpperCase(),
            tr.left + tr.width * 0.5,
            tr.top + tr.height * 0.5,
          );
        }
        if (subEl) {
          const sr = subEl.getBoundingClientRect();
          ctx.font = `600 11.5px ${FONT_STACK}`;
          ctx.fillStyle = 'rgba(255, 236, 236, 0.94)';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(subEl.textContent ?? '', sr.left + sr.width * 0.5, sr.top + sr.height * 0.5);
        }
        ctx.restore();
      }
    }
  }

  private drawBottomRightTelemetry(ctx: CanvasRenderingContext2D): void {
    // Trick / slope clue pill (e.g., BACKFLIP 361°, SPIN 180°, PUMPING ++)
    const slopeEl = document.getElementById('slope-display');
    const slopeRect = isRectVisible(slopeEl);
    if (slopeEl && slopeRect) {
      const style = window.getComputedStyle(slopeEl);
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
      ctx.shadowBlur = 16;
      ctx.shadowOffsetY = 5;
      drawRoundedRect(
        ctx,
        slopeRect.left,
        slopeRect.top,
        slopeRect.width,
        slopeRect.height,
        slopeRect.height * 0.5,
      );
      ctx.fillStyle = 'rgba(10, 18, 30, 0.54)';
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.font = `800 11px ${FONT_STACK}`;
      ctx.fillStyle = style.color || '#9be0ff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.62)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 1;
      ctx.fillText(
        (slopeEl.textContent ?? '').toUpperCase(),
        slopeRect.left + slopeRect.width * 0.5,
        slopeRect.top + slopeRect.height * 0.5,
      );
      ctx.restore();
    }

    // Desktop circular speedometer dial
    const speedoWrap = document.getElementById('speedo-wrap');
    const speedoRect = isRectVisible(speedoWrap);
    if (speedoWrap && speedoRect) {
      this.drawSpeedometerDial(ctx, speedoWrap, speedoRect);
      return;
    }

    // Fallback: compact mobile speed pill
    const mobilePill = document.getElementById('mobile-speed-pill');
    const mobileRect = isRectVisible(mobilePill);
    if (mobilePill && mobileRect) {
      const speedText = document.getElementById('m-speed-display')?.textContent ?? '0';
      const surfEl = document.getElementById('m-surface-display');
      const surfText = (surfEl?.textContent ?? '').toUpperCase();
      const surfColor = surfEl ? window.getComputedStyle(surfEl).color : '#9be0ff';
      ctx.save();
      drawRoundedRect(
        ctx,
        mobileRect.left,
        mobileRect.top,
        mobileRect.width,
        mobileRect.height,
        14,
      );
      ctx.fillStyle = 'rgba(10, 18, 30, 0.62)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
      ctx.lineWidth = 1;
      ctx.stroke();

      const cx = mobileRect.left + mobileRect.width * 0.5;
      ctx.font = `900 26px ${FONT_STACK}`;
      ctx.fillStyle = '#f8fbff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(speedText, cx, mobileRect.top + mobileRect.height * 0.38);

      ctx.font = `800 8px ${FONT_STACK}`;
      ctx.fillStyle = 'rgba(215, 232, 252, 0.68)';
      ctx.fillText('KM/H', cx, mobileRect.top + mobileRect.height * 0.64);

      ctx.font = `800 8px ${FONT_STACK}`;
      ctx.fillStyle = surfColor;
      ctx.fillText(surfText, cx, mobileRect.top + mobileRect.height * 0.84);
      ctx.restore();
    }
  }

  private drawSpeedometerDial(
    ctx: CanvasRenderingContext2D,
    speedoWrap: HTMLElement,
    rect: DOMRect,
  ): void {
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    const scale = rect.width / 180;
    const radius = rect.width * 0.5;
    const isSurge = speedoWrap.classList.contains('surge');
    const isRedline = speedoWrap.classList.contains('redline');

    // Read live SVG arc progress from DOM so dial matches exact smoothed frame state
    const speedArcEl = document.getElementById('speed-arc');
    const speedOffsetRaw = parseFloat(
      speedArcEl?.style.strokeDashoffset ||
        speedArcEl?.getAttribute('stroke-dashoffset') ||
        String(SPEED_ARC_LEN),
    );
    const speedFrac = Math.max(
      0,
      Math.min(
        1,
        1 - (Number.isFinite(speedOffsetRaw) ? speedOffsetRaw : SPEED_ARC_LEN) / SPEED_ARC_LEN,
      ),
    );

    const pumpArcEl = document.getElementById('pump-arc');
    const pumpOffsetRaw = parseFloat(
      pumpArcEl?.style.strokeDashoffset ||
        pumpArcEl?.getAttribute('stroke-dashoffset') ||
        String(PUMP_ARC_LEN),
    );
    const pumpFrac = Math.max(
      0,
      Math.min(
        1,
        1 - (Number.isFinite(pumpOffsetRaw) ? pumpOffsetRaw : PUMP_ARC_LEN) / PUMP_ARC_LEN,
      ),
    );

    // Dial background + bezel glow
    ctx.save();
    ctx.shadowColor = isSurge
      ? 'rgba(71, 255, 156, 0.45)'
      : isRedline
        ? 'rgba(255, 91, 91, 0.42)'
        : 'rgba(0, 0, 0, 0.42)';
    ctx.shadowBlur = isSurge || isRedline ? 28 : 24;
    ctx.shadowOffsetY = isSurge || isRedline ? 4 : 10;

    const bgGrad = ctx.createRadialGradient(cx, cy - radius * 0.16, radius * 0.1, cx, cy, radius);
    bgGrad.addColorStop(0, 'rgba(10, 18, 30, 0.58)');
    bgGrad.addColorStop(0.72, 'rgba(8, 14, 24, 0.66)');
    bgGrad.addColorStop(1, 'rgba(6, 12, 22, 0.74)');

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = bgGrad;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = isSurge
      ? 'rgba(71, 255, 156, 0.78)'
      : isRedline
        ? 'rgba(255, 107, 74, 0.78)'
        : 'rgba(255, 255, 255, 0.24)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Arc sweep: 260° from 140° (7:30) clockwise to 400° (4:30)
    const startRad = (140 * Math.PI) / 180;
    const sweepRad = (260 * Math.PI) / 180;
    const endRad = startRad + sweepRad;

    // Outer speed track
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, 72 * scale, startRad, endRad);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.11)';
    ctx.lineWidth = 10 * scale;
    ctx.stroke();

    // Active glowing speed arc
    if (speedFrac > 0.004) {
      const arcGrad = ctx.createLinearGradient(rect.left, rect.bottom, rect.right, rect.top);
      arcGrad.addColorStop(0, '#4de8ff');
      arcGrad.addColorStop(0.48, '#47ff9c');
      arcGrad.addColorStop(0.78, '#ffd447');
      arcGrad.addColorStop(1, '#ff5252');

      ctx.save();
      ctx.shadowColor = speedFrac > 0.75 ? 'rgba(255, 130, 70, 0.55)' : 'rgba(71, 255, 156, 0.55)';
      ctx.shadowBlur = 7 * scale;
      ctx.beginPath();
      ctx.arc(cx, cy, 72 * scale, startRad, startRad + sweepRad * speedFrac);
      ctx.strokeStyle = arcGrad;
      ctx.lineWidth = 10 * scale;
      ctx.stroke();
      ctx.restore();
    }

    // Inner pump / charge track
    ctx.beginPath();
    ctx.arc(cx, cy, 58 * scale, startRad, endRad);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 4 * scale;
    ctx.stroke();

    if (pumpFrac > 0.004) {
      ctx.save();
      ctx.shadowColor = 'rgba(71, 255, 156, 0.6)';
      ctx.shadowBlur = 6 * scale;
      ctx.beginPath();
      ctx.arc(cx, cy, 58 * scale, startRad, startRad + sweepRad * pumpFrac);
      ctx.strokeStyle = '#47ff9c';
      ctx.lineWidth = 4 * scale;
      ctx.stroke();
      ctx.restore();
    }

    // Radial precision ticks & labels (0, 60, 120, 180)
    const steps = 18;
    for (let i = 0; i <= steps; i++) {
      const frac = i / steps;
      const kmhVal = i * 10;
      const isMajor = kmhVal % 20 === 0;
      const isTickRed = kmhVal >= 140;
      const deg = -130 + frac * 260;
      const rad = ((deg - 90) * Math.PI) / 180;
      const rOuter = 82 * scale;
      const rInner = (isMajor ? 75 : 78) * scale;

      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(rad) * rInner, cy + Math.sin(rad) * rInner);
      ctx.lineTo(cx + Math.cos(rad) * rOuter, cy + Math.sin(rad) * rOuter);
      ctx.strokeStyle = isTickRed
        ? 'rgba(255, 92, 92, 0.85)'
        : isMajor
          ? 'rgba(235, 245, 255, 0.72)'
          : 'rgba(235, 245, 255, 0.28)';
      ctx.lineWidth = (isMajor ? 1.8 : 1) * scale;
      ctx.stroke();

      if (kmhVal % 60 === 0) {
        const rTxt = 47 * scale;
        ctx.font = `700 ${(8.5 * scale).toFixed(1)}px ${FONT_STACK}`;
        ctx.fillStyle = isTickRed ? 'rgba(255, 118, 108, 0.85)' : 'rgba(210, 228, 248, 0.5)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(kmhVal), cx + Math.cos(rad) * rTxt, cy + Math.sin(rad) * rTxt);
      }
    }

    // Rotating white tip needle
    const needleDeg = -130 + speedFrac * 260;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((needleDeg * Math.PI) / 180);
    ctx.shadowColor = 'rgba(255, 255, 255, 0.7)';
    ctx.shadowBlur = 6 * scale;
    ctx.beginPath();
    ctx.moveTo(0, -64 * scale);
    ctx.lineTo(0, -77 * scale);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3 * scale;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -72 * scale, 2.6 * scale, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    // Center speed number & KM/H unit
    const speedNumEl = document.getElementById('speed-display');
    const speedText = speedNumEl?.textContent ?? '0';
    ctx.save();
    ctx.font = `900 ${(46 * scale).toFixed(1)}px ${FONT_STACK}`;
    ctx.fillStyle = '#f8fbff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(95, 243, 255, 0.28)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 2;
    ctx.fillText(speedText, cx, cy - 2 * scale);

    ctx.shadowColor = 'transparent';
    ctx.font = `800 ${(10 * scale).toFixed(1)}px ${FONT_STACK}`;
    ctx.fillStyle = 'rgba(215, 232, 252, 0.64)';
    ctx.fillText('KM/H', cx, cy + 25 * scale);
    ctx.restore();

    // Bottom surface pill
    const surfEl = document.getElementById('surface-display');
    const surfRect = isRectVisible(surfEl);
    if (surfEl && surfRect) {
      const surfStyle = window.getComputedStyle(surfEl);
      drawRoundedRect(
        ctx,
        surfRect.left,
        surfRect.top,
        surfRect.width,
        surfRect.height,
        surfRect.height * 0.5,
      );
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.font = `800 ${(9.5 * scale).toFixed(1)}px ${FONT_STACK}`;
      ctx.fillStyle = surfStyle.color || '#9be0ff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        (surfEl.textContent ?? '').toUpperCase(),
        surfRect.left + surfRect.width * 0.5,
        surfRect.top + surfRect.height * 0.5,
      );
    }

    ctx.restore();
  }
}
