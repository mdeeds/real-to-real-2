/**
 * Handles audio playback scheduling and synchronization.
 * Manages AudioBufferSourceNodes and ensures tracks play in sync.
 */
export class AudioPlaybackEngine {
    constructor(audioCtx, database) {
        this.audioCtx = audioCtx;
        this.database = database;
        this.activeSources = [];
        this.bufferCache = new Map();
    }

    /**
     * Returns true if there are currently active audio sources.
     */
    get isPlaying() {
        return this.activeSources.length > 0;
    }

    /**
     * Stops any currently playing audio.
     */
    stop() {
        this.activeSources.forEach(source => {
            try {
                source.stop();
                source.disconnect();
            } catch (e) {
                // Ignore if already stopped
            }
        });
        this.activeSources = [];
    }

    /**
     * Plays the provided tracks starting from the timeline position `startTime`.
     * @param {Array} tracks - List of track metadata objects.
     * @param {number} startTime - The point in the timeline (seconds) to start playback.
     * @param {number} [duration=null] - How long to play (seconds). If null, plays until end of tracks.
     */
    async play(tracks, startTime, duration = null) {
        // 1. Stop existing playback
        this.stop();

        if (!tracks || tracks.length === 0) return;

        // 2. Fetch and Decode Buffers (Parallel)
        // Identify unique files needed for this playback
        const filenames = [...new Set(tracks.map(t => t.filename))];

        // Ensure all needed buffers are in cache
        await Promise.all(filenames.map(f => this._ensureBufferLoaded(f)));

        // 3. Schedule Sources
        const now = this.audioCtx.currentTime;
        const startDelay = 0.05; // 50ms lookahead to ensure synchronization
        const masterStartTime = now + startDelay;
        const regionEnd = duration !== null ? startTime + duration : Infinity;

        tracks.forEach(track => {
            const buffer = this.bufferCache.get(track.filename);
            if (!buffer) return;

            const trackStart = track.startTime || 0;
            const trackDuration = buffer.duration;
            const trackEnd = trackStart + trackDuration;

            // Check if track intersects with the playback region
            if (trackEnd <= startTime || trackStart >= regionEnd) {
                return;
            }

            // Calculate 'when' (AudioContext time) and 'offset' (Buffer time)
            let when = masterStartTime;
            let offset = 0;

            if (startTime > trackStart) {
                // Playback starts in the middle of the track
                offset = startTime - trackStart;
            } else {
                // Track starts after the playback start time
                // Delay the start of this specific source
                const delay = trackStart - startTime;
                when += delay;
                offset = 0;
            }

            // Calculate duration to play for this specific source
            // Play until: min(regionEnd, trackEnd)
            const playEnd = Math.min(regionEnd, trackEnd);
            // Effective start in timeline: max(startTime, trackStart)
            const effectiveStart = Math.max(startTime, trackStart);
            const playDuration = playEnd - effectiveStart;

            if (playDuration <= 0) return;

            // Create and Schedule Source
            const source = this.audioCtx.createBufferSource();
            source.buffer = buffer;
            source.connect(this.audioCtx.destination);

            // start(when, offset, duration)
            source.start(when, offset, playDuration);
            this.activeSources.push(source);

            // Cleanup when done
            source.onended = () => {
                const idx = this.activeSources.indexOf(source);
                if (idx > -1) this.activeSources.splice(idx, 1);
            };
        });
    }

    /**
     * Helper to fetch raw buffer from IDB and decode it if not cached.
     */
    async _ensureBufferLoaded(filename) {
        if (this.bufferCache.has(filename)) return;

        try {
            const arrayBuffer = await this.database.getAudioBuffer(filename);
            if (arrayBuffer) {
                // Decode the raw file data
                // We slice(0) to ensure we don't detach the buffer if IDB behavior varies
                const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer.slice(0));
                this.bufferCache.set(filename, audioBuffer);
            }
        } catch (err) {
            console.error(`Failed to load or decode audio for ${filename}`, err);
        }
    }
}
