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
        this.trackNodes = new Map(); // filename -> { panner, highpass, lowpass, gain }

        this.masterGain = this.audioCtx.createGain();
        this.analyserNode = this.audioCtx.createAnalyser();
        this.analyserNode.fftSize = 256;
        this.masterGain.connect(this.analyserNode);
        this.analyserNode.connect(this.audioCtx.destination);
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

    updateTrackNodes(filename, pan, hpFreq, lpFreq) {
        const nodes = this.trackNodes.get(filename);
        if (nodes) {
            const now = this.audioCtx.currentTime;
            if (pan !== undefined) nodes.panner.pan.setTargetAtTime(pan, now, 0.05);
            if (hpFreq !== undefined) nodes.highpass.frequency.setTargetAtTime(hpFreq, now, 0.05);
            if (lpFreq !== undefined) nodes.lowpass.frequency.setTargetAtTime(lpFreq, now, 0.05);
        }
    }

    deleteTrackNodes(filename) {
        const nodes = this.trackNodes.get(filename);
        if (nodes) {
            nodes.gain.disconnect();
            nodes.highpass.disconnect();
            nodes.lowpass.disconnect();
            nodes.panner.disconnect();
            this.trackNodes.delete(filename);
        }
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

        if (!tracks || tracks.length === 0) {
            const now = this.audioCtx.currentTime;
            const startDelay = 0.05; // 50ms lookahead
            return now + startDelay;
        }

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

            // Create or get nodes for this track
            let nodes = this.trackNodes.get(track.filename);
            if (!nodes) {
                const panner = this.audioCtx.createStereoPanner();
                const highpass = this.audioCtx.createBiquadFilter();
                highpass.type = 'highpass';
                highpass.frequency.value = 20;

                const lowpass = this.audioCtx.createBiquadFilter();
                lowpass.type = 'lowpass';
                lowpass.frequency.value = 20000;

                const gain = this.audioCtx.createGain();
                gain.gain.value = 1.0;

                // source -> gain -> highpass -> lowpass -> panner -> masterGain
                gain.connect(highpass);
                highpass.connect(lowpass);
                lowpass.connect(panner);
                panner.connect(this.masterGain);

                nodes = { gain, highpass, lowpass, panner };
                this.trackNodes.set(track.filename, nodes);
            }

            // Apply current track settings if they exist
            nodes.panner.pan.value = track.pan !== undefined ? track.pan : 0;
            nodes.highpass.frequency.value = track.hpFreq !== undefined ? track.hpFreq : 20;
            nodes.lowpass.frequency.value = track.lpFreq !== undefined ? track.lpFreq : 20000;

            source.connect(nodes.gain);

            // start(when, offset, duration)
            source.start(when, offset, playDuration);
            this.activeSources.push(source);

            // Cleanup when done
            source.onended = () => {
                const idx = this.activeSources.indexOf(source);
                if (idx > -1) this.activeSources.splice(idx, 1);
            };
        });

        return masterStartTime;
    }

    /**
     * Deletes a track's audio nodes and cached buffer.
     */
    deleteTrackNodes(filename) {
        const nodes = this.trackNodes.get(filename);
        if (nodes) {
            nodes.panner.disconnect();
            nodes.lowpass.disconnect();
            nodes.highpass.disconnect();
            nodes.gain.disconnect();
            this.trackNodes.delete(filename);
        }
        this.bufferCache.delete(filename);
    }

    /**
     * Helper to fetch decoded audio from IDB and reconstruct AudioBuffer if not cached.
     */
    async _ensureBufferLoaded(filename) {
        if (this.bufferCache.has(filename)) return;

        try {
            // First try to get the pre-decoded audio
            const decodedAudio = await this.database.getDecodedAudio(filename);
            
            if (decodedAudio) {
                // Reconstruct AudioBuffer from raw Float32Arrays
                const audioBuffer = this.audioCtx.createBuffer(
                    decodedAudio.numberOfChannels,
                    decodedAudio.length,
                    decodedAudio.sampleRate
                );
                
                for (let i = 0; i < decodedAudio.numberOfChannels; i++) {
                    audioBuffer.copyToChannel(decodedAudio.channels[i], i);
                }
                
                this.bufferCache.set(filename, audioBuffer);
                return;
            }

            // Fallback to legacy audio_buffers if decoded_audio is missing
            const arrayBuffer = await this.database.getAudioBuffer(filename);
            if (arrayBuffer) {
                console.warn(`[AudioPlaybackEngine] Falling back to decodeAudioData for ${filename}`);
                const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer.slice(0));
                this.bufferCache.set(filename, audioBuffer);
            }
        } catch (err) {
            console.error(`Failed to load or decode audio for ${filename}`, err);
        }
    }
}
