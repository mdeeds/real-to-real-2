/**
 * Pure rendering class for the Timeline.
 * Handles the low-level Canvas 2D API calls to draw tracks and cursors.
 */
export class TimelineDrawer {
    /**
     * Draws the complete timeline frame.
     * @param {CanvasRenderingContext2D} ctx
     * @param {Object} state - The current visual state of the renderer.
     */
    draw(ctx, state) {
        const {
            width, height, tracks, viewOffset,
            pixelsPerSecond, resolutionKey,
            hoveredTrackIndex, cursorTime,
            colors, trackHeight
        } = state;

        // 1. Fill Background
        ctx.fillStyle = colors.background;
        ctx.fillRect(0, 0, width, height);

        // 2. Draw each track
        tracks.forEach((track, index) => {
            this._drawTrack(ctx, track, index, state);
        });

        // 3. Draw Hairline
        this._drawHairline(ctx, state);
    }

    /**
     * Internal helper to draw a single track.
     */
    _drawTrack(ctx, track, index, state) {
        const {
            width, viewOffset, pixelsPerSecond,
            resolutionKey, hoveredTrackIndex,
            colors, trackHeight
        } = state;

        const yStart = index * trackHeight;
        const halfHeight = trackHeight / 2;
        const centerY = yStart + halfHeight;

        // Check cache
        if (!track.renderCache || !track.renderCache[resolutionKey]) {
            ctx.fillStyle = colors.text;
            ctx.fillText(`Loading... ${track.filename}`, 10, yStart + 20);
            return;
        }

        const peaks = track.renderCache[resolutionKey];
        const { min, max, rms } = peaks;

        // Calculate horizontal position
        const startPixel = Math.floor(((track.startTime || 0) - viewOffset) * pixelsPerSecond);

        // Culling: Determine visible range
        const renderStart = Math.max(0, -startPixel);
        const renderEnd = Math.min(min.length, width - startPixel);

        if (renderEnd <= renderStart) return;

        // --- Draw Waveform Body (Min/Max) ---
        ctx.fillStyle = colors.waveform;
        ctx.beginPath();
        for (let i = renderStart; i < renderEnd; i++) {
            const x = startPixel + i;
            const yTop = centerY - (max[i] * halfHeight);
            const yBottom = centerY - (min[i] * halfHeight);
            ctx.rect(x, yTop, 1, yBottom - yTop);
        }
        ctx.fill();

        // --- Draw RMS (Energy) ---
        const isHovered = index === hoveredTrackIndex;
        ctx.fillStyle = isHovered ? colors.rmsHover : colors.rms;
        ctx.beginPath();
        for (let i = renderStart; i < renderEnd; i++) {
            const x = startPixel + i;
            const val = rms[i];
            const h = val * halfHeight * 2;
            const yTop = centerY - (val * halfHeight);
            ctx.rect(x, yTop, 1, h);
        }
        ctx.fill();

        // --- Draw Track Info Overlay ---
        ctx.fillStyle = colors.text;
        ctx.font = '12px sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillText(`#${index + 1}: ${track.filename}`, 5, yStart);
    }

    _drawHairline(ctx, state) {
        const { width, height, cursorTime, viewOffset, pixelsPerSecond, colors } = state;

        const x = (cursorTime - viewOffset) * pixelsPerSecond;
        if (x >= 0 && x <= width) {
            ctx.fillStyle = colors.hairline;
            ctx.fillRect(x, 0, 1, height);
        }
    }
}
