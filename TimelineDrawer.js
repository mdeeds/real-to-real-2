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

        // 1.5 Draw Metronome Lines
        if (state.metronome && state.metronome.isEnabled) {
            this._drawMetronomeLines(ctx, state);
        }

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

    _drawMetronomeLines(ctx, state) {
        const { width, height, viewOffset, pixelsPerSecond, resolutionKey, metronome } = state;
        const bpm = metronome.bpm;
        const beatsPerBar = metronome.beatsPerBar;
        const secondsPerBeat = 60 / bpm;
        const secondsPerBar = secondsPerBeat * beatsPerBar;

        // Determine what to draw based on zoom level
        // zoom 1: resolutionKey '1' (1000 pps) -> draw every beat
        // zoom 2: resolutionKey '10' (100 pps) -> draw every beat
        // zoom 3: resolutionKey '100' (10 pps) -> draw every measure (bar)
        const drawEveryBeat = resolutionKey === '1' || resolutionKey === '10';
        const interval = drawEveryBeat ? secondsPerBeat : secondsPerBar;

        // Find the first line to draw
        const firstLineTime = Math.floor(viewOffset / interval) * interval;
        const lastLineTime = viewOffset + (width / pixelsPerSecond);

        ctx.strokeStyle = '#e0e0e0'; // light grey
        ctx.lineWidth = 1;
        ctx.beginPath();

        for (let t = firstLineTime; t <= lastLineTime; t += interval) {
            if (t < 0) continue; // Metronome starts at 0
            
            const x = (t - viewOffset) * pixelsPerSecond;
            
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
        }
        ctx.stroke();
    }
}
