import { TimelineDrawer } from './TimelineDrawer.js';

/**
 * Handles the visual rendering of audio tracks on the main canvas.
 * Manages track ordering, layout, and drawing of pre-calculated waveform peaks.
 */
export class AudioRenderer {
    /**
     * @param {HTMLCanvasElement} canvas - The DOM Canvas element to draw on.
     */
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false });

        this.drawer = new TimelineDrawer();
        /** @type {Array<Object>} List of track metadata objects containing renderCache. */
        this.tracks = [];
        this.hoveredTrackIndex = -1;
        this.selectedTrackIndex = -1;
        this.animationFrameId = null;
        this.viewOffset = 0; // Horizontal scroll position in seconds
        this.targetViewOffset = 0; // Target scroll position for smoothing
        this.lastFrameTime = 0;
        this.mouseX = 0;
        this.cursorTime = 0; // Absolute time in seconds for the hairline cursor

        // Drag State
        this.dragState = {
            isDragging: false,
            trackIndex: -1,
            startX: 0,
            startY: 0,
            originalStartTime: 0
        };

        // Zoom Levels
        this.zoomLevels = [
            { key: '1', pps: 1000, height: 60 }, // 1ms
            { key: '10', pps: 100, height: 40 }, // 10ms
            { key: '100', pps: 10, height: 30 }  // 100ms
        ];
        this.currentZoomIndex = 1; // Default to '10'

        // Rendering Configuration
        const initialZoom = this.zoomLevels[this.currentZoomIndex];
        this.trackHeight = initialZoom.height;    // Height in pixels for each track
        this.resolutionKey = initialZoom.key; // Use the 10ms peaks (matches 10ms/pixel requirement)
        this.pixelsPerSecond = initialZoom.pps; // 10ms per pixel = 100 pixels per second

        // Theme Colors
        this.colors = {
            background: '#ffffff', // White
            waveform: '#000000',   // Black (Min/Max)
            rms: '#555555',        // Dark Grey (RMS)
            rmsHover: '#007bff',   // Blue for hover
            text: '#000000',       // Black text
            separator: '#e0e0e0',  // Light grey separator line
            hairline: '#ff0000'    // Red hairline
        };

        // Event Listeners
        window.addEventListener('resize', this.handleResize.bind(this));
        window.addEventListener('keydown', this.handleKeyDown.bind(this));
        this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
        this.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
        this.canvas.addEventListener('mouseleave', this.handleMouseLeave.bind(this));

        // Start the render loop
        this.startRenderLoop();
    }

    /**
     * Adds a track to the renderer and updates the view.
     * Assigns a track number (index) based on the order.
     * @param {Object} metadata - AudioMetadata object from AudioDatabase.
     */
    addTrack(metadata) {
        this.tracks.push(metadata);
        this.updateTrackLayout();
    }

    /**
     * Removes a track by its visual index.
     * @param {number} index - The rendered index of the track (0-based).
     */
    removeTrack(index) {
        if (index >= 0 && index < this.tracks.length) {
            this.tracks.splice(index, 1);
            this.updateTrackLayout();
        }
    }

    /**
     * Reorders a track within the list.
     * @param {number} fromIndex - Current index of the track.
     * @param {number} toIndex - New index for the track.
     */
    reorderTracks(fromIndex, toIndex) {
        if (fromIndex < 0 || fromIndex >= this.tracks.length ||
            toIndex < 0 || toIndex >= this.tracks.length) {
            return;
        }

        const track = this.tracks.splice(fromIndex, 1)[0];
        this.tracks.splice(toIndex, 0, track);

        this.updateTrackLayout();
    }

    /**
     * Updates internal state regarding track indices and canvas dimensions.
     */
    updateTrackLayout() {
        // Update the trackIndex property on the metadata objects to match visual order
        this.tracks.forEach((track, index) => {
            track.trackIndex = index;
        });

        // Resize canvas height to accommodate all tracks
        // Ensure it's at least the size of the container or 0 if empty
        const totalHeight = Math.max(
            this.tracks.length * this.trackHeight,
            this.canvas.parentElement ? this.canvas.parentElement.clientHeight : 0
        );

        // Only resize if necessary to avoid flickering or state loss
        if (this.canvas.height !== totalHeight) {
            this.canvas.height = totalHeight;
        }

        // Sync width with parent container
        if (this.canvas.parentElement && this.canvas.width !== this.canvas.parentElement.clientWidth) {
            this.canvas.width = this.canvas.parentElement.clientWidth;
        }
    }

    /**
     * Clears and redraws the entire canvas.
     */
    render() {
        // Collect State Snapshot
        const state = {
            width: this.canvas.width,
            height: this.canvas.height,
            tracks: this.tracks,
            viewOffset: this.viewOffset,
            pixelsPerSecond: this.pixelsPerSecond,
            resolutionKey: this.resolutionKey,
            hoveredTrackIndex: this.hoveredTrackIndex,
            selectedTrackIndex: this.selectedTrackIndex,
            cursorTime: this.cursorTime,
            colors: this.colors,
            trackHeight: this.trackHeight
        };

        // Delegate to Drawer
        this.drawer.draw(this.ctx, state);
    }

    /**
     * Starts the continuous rendering loop.
     */
    startRenderLoop() {
        const loop = (timestamp) => {
            if (!this.lastFrameTime) this.lastFrameTime = timestamp;
            const dt = (timestamp - this.lastFrameTime) / 1000;
            this.lastFrameTime = timestamp;

            // Smooth Scrolling Logic
            if (this.viewOffset !== this.targetViewOffset) {
                const dist = this.targetViewOffset - this.viewOffset;
                const distAbs = Math.abs(dist);

                // Minimum speed: 20 pixels per second (converted to seconds based on zoom)
                const minSpeed = 20 / this.pixelsPerSecond;
                // Proportional speed: Halfway in 0.25s -> v = d * ln(2)/0.25
                const propSpeed = distAbs * (Math.LN2 / 0.25);

                const speed = Math.max(minSpeed, propSpeed);
                const step = speed * dt;

                if (step >= distAbs) {
                    this.viewOffset = this.targetViewOffset;
                } else {
                    this.viewOffset += Math.sign(dist) * step;
                }
            }

            this.render();
            this.animationFrameId = requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }

    /**
     * Handles window resize events to keep the canvas dimensions correct.
     */
    handleResize() {
        this.updateTrackLayout();
    }

    /**
     * Tracks mouse movement over the canvas to identify the hovered track or handle dragging.
     * @param {MouseEvent} event 
     */
    handleMouseMove(event) {
        const rect = this.canvas.getBoundingClientRect();
        this.mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;

        // 1. Handle Dragging
        if (this.dragState.trackIndex !== -1 && (event.buttons === 1)) {
            const dx = this.mouseX - this.dragState.startX;
            const dy = mouseY - this.dragState.startY;

            // Threshold to begin a drag operation
            if (!this.dragState.isDragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
                this.dragState.isDragging = true;
            }

            if (this.dragState.isDragging) {
                const track = this.tracks[this.dragState.trackIndex];

                // Determine dominant axis
                if (Math.abs(dy) > Math.abs(dx)) {
                    // Vertical: Snap time back to original and reorder
                    track.startTime = this.dragState.originalStartTime;

                    const toIndex = Math.floor(mouseY / this.trackHeight);
                    if (toIndex >= 0 && toIndex < this.tracks.length && toIndex !== this.dragState.trackIndex) {
                        this.reorderTracks(this.dragState.trackIndex, toIndex);
                        this.dragState.trackIndex = toIndex;
                    }
                } else {
                    // Horizontal: Move time
                    track.startTime = this.dragState.originalStartTime + (dx / this.pixelsPerSecond);
                }
            }
        }

        // 2. Handle Hover (disable if dragging to prevent flickering)
        if (!this.dragState.isDragging) {
            const trackIndex = Math.floor(mouseY / this.trackHeight);
            if (trackIndex >= 0 && trackIndex < this.tracks.length) {
                this.hoveredTrackIndex = trackIndex;
            } else {
                this.hoveredTrackIndex = -1;
            }
        }
    }

    /**
     * Resets the hovered track when the mouse leaves the canvas.
     */
    handleMouseLeave() {
        this.hoveredTrackIndex = -1;
        // Cancel drag if mouse leaves canvas to prevent stuck state
        this.dragState = {
            isDragging: false,
            trackIndex: -1,
            startX: 0,
            startY: 0,
            originalStartTime: 0
        };
    }

    /**
     * Initiates drag or prepares for click.
     * @param {MouseEvent} event 
     */
    handleMouseDown(event) {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const trackIndex = Math.floor(y / this.trackHeight);

        if (trackIndex >= 0 && trackIndex < this.tracks.length) {
            this.selectedTrackIndex = trackIndex;
            this.dragState = {
                isDragging: false,
                trackIndex: trackIndex,
                startX: x,
                startY: y,
                originalStartTime: this.tracks[trackIndex].startTime || 0
            };
        } else {
            this.selectedTrackIndex = -1;
            // Clicked empty space
            this.dragState = {
                isDragging: false,
                trackIndex: -1,
                startX: x,
                startY: y,
                originalStartTime: 0
            };
        }
    }

    /**
     * Finalizes click (hairline move) or drag.
     * @param {MouseEvent} event 
     */
    handleMouseUp(event) {
        // If we weren't dragging, treat it as a click to move hairline
        if (!this.dragState.isDragging) {
            const rect = this.canvas.getBoundingClientRect();
            const clickX = event.clientX - rect.left;
            this.cursorTime = this.viewOffset + (clickX / this.pixelsPerSecond);
        } else {
            // Dispatch event so the app can save the new position/order
            this.canvas.dispatchEvent(new CustomEvent('tracks-updated', {
                detail: { tracks: this.tracks }
            }));
        }

        // Reset Drag State
        this.dragState = {
            isDragging: false,
            trackIndex: -1,
            startX: 0,
            startY: 0,
            originalStartTime: 0
        };
    }

    /**
     * Handles keyboard shortcuts for zooming.
     * @param {KeyboardEvent} event 
     */
    handleKeyDown(event) {
        // Avoid interfering with input elements if any exist
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;

        switch (event.key) {
            case 'Delete':
                if (this.hoveredTrackIndex !== -1) {
                    this.removeTrack(this.hoveredTrackIndex);
                }
                break;
            case ' ':
                event.preventDefault(); // Prevent scrolling
                // Calculate duration of the visible screen
                const visibleDuration = this.canvas.width / this.pixelsPerSecond;
                this.canvas.dispatchEvent(new CustomEvent('playback-start', {
                    detail: {
                        startTime: this.viewOffset,
                        duration: visibleDuration,
                        tracks: this.tracks
                    }
                }));
                break;
            case '1': this.setZoom(0); break;
            case '2': this.setZoom(1); break;
            case '3': this.setZoom(2); break;
            case '+': case '=': this.setZoom(this.currentZoomIndex - 1); break; // Zoom In
            case '-': case '_': this.setZoom(this.currentZoomIndex + 1); break; // Zoom Out
            case 's':
            case 'S':
                // Solo Playback Logic: Track under mouse, time under mouse
                {
                    const timeAtMouse = this.viewOffset + (this.mouseX / this.pixelsPerSecond);
                    const track = (this.hoveredTrackIndex !== -1) ? this.tracks[this.hoveredTrackIndex] : null;

                    // Dispatch event for Main application to handle audio
                    this.canvas.dispatchEvent(new CustomEvent('playback-solo', {
                        detail: {
                            track: track,
                            startTime: timeAtMouse
                        }
                    }));
                }
                break;
            case 'ArrowLeft':
                this.targetViewOffset = Math.max(0, this.targetViewOffset - (this.canvas.width / this.pixelsPerSecond) * 0.25);
                break;
            case 'ArrowRight':
                this.targetViewOffset += (this.canvas.width / this.pixelsPerSecond) * 0.25;
                break;
            case 'Home':
                this.targetViewOffset = 0;
                break;
        }
    }

    /**
     * Updates zoom level while keeping the time under the mouse cursor stationary.
     * @param {number} index - Index into zoomLevels array.
     */
    setZoom(index) {
        if (index < 0 || index >= this.zoomLevels.length || index === this.currentZoomIndex) return;

        // 1. Calculate the specific time point currently under the mouse
        const timeAtMouse = this.viewOffset + (this.mouseX / this.pixelsPerSecond);

        // 2. Update Zoom State
        this.currentZoomIndex = index;
        const level = this.zoomLevels[index];
        this.resolutionKey = level.key;
        this.pixelsPerSecond = level.pps;
        this.trackHeight = level.height;

        // 3. Recalculate viewOffset so that timeAtMouse remains under mouseX
        // New Offset = TimeAtMouse - (MouseX / NewPPS)
        this.viewOffset = Math.max(0, timeAtMouse - (this.mouseX / this.pixelsPerSecond));
        this.targetViewOffset = this.viewOffset;

        this.updateTrackLayout();
    }
}
