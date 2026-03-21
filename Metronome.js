export class Metronome {
    constructor(audioCtx) {
        this.audioCtx = audioCtx;
        this.bpm = 120;
        this.beatsPerBar = 4;
        this.buffer = null;
        this.source = null;
        
        this.gainNode = this.audioCtx.createGain();
        this.gainNode.gain.value = 0.5; // Default volume
        
        this.isEnabled = false;
        this.isPlaying = false;
    }

    setBpm(bpm) {
        this.bpm = bpm;
        this.buffer = null; // Invalidate buffer so it regenerates on next start
    }

    setEnabled(enabled) {
        this.isEnabled = enabled;
    }

    connect(destination) {
        this.gainNode.connect(destination);
    }

    _generateBuffer() {
        const secondsPerBeat = 60 / this.bpm;
        const secondsPerBar = secondsPerBeat * this.beatsPerBar;
        const sampleRate = this.audioCtx.sampleRate;
        const length = Math.ceil(secondsPerBar * sampleRate);
        
        this.buffer = this.audioCtx.createBuffer(1, length, sampleRate);
        const data = this.buffer.getChannelData(0);

        // Generate clicks
        for (let beat = 0; beat < this.beatsPerBar; beat++) {
            const beatTime = beat * secondsPerBeat;
            const beatSample = Math.floor(beatTime * sampleRate);
            
            // Short sine wave burst
            const clickDuration = 0.05; // 50ms
            const clickSamples = Math.floor(clickDuration * sampleRate);
            const frequency = beat === 0 ? 1000 : 800; // Higher pitch for the first beat
            
            for (let i = 0; i < clickSamples; i++) {
                if (beatSample + i < length) {
                    // Apply a simple envelope (exponential decay)
                    const envelope = Math.exp(-i / (sampleRate * 0.01));
                    data[beatSample + i] = Math.sin(2 * Math.PI * frequency * i / sampleRate) * envelope;
                }
            }
        }
    }

    start(timelineStartTime, masterStartTime) {
        if (!this.isEnabled) return;
        
        if (!this.buffer) {
            this._generateBuffer();
        }

        this.stop();

        this.source = this.audioCtx.createBufferSource();
        this.source.buffer = this.buffer;
        this.source.loop = true;
        this.source.connect(this.gainNode);

        const secondsPerBar = (60 / this.bpm) * this.beatsPerBar;
        
        // Calculate the offset into the buffer based on the timeline start time
        // The metronome conceptually starts at timeline time 0.
        let offset = timelineStartTime % secondsPerBar;
        if (offset < 0) {
            offset += secondsPerBar;
        }

        this.source.start(masterStartTime, offset);
        this.isPlaying = true;
    }

    stop() {
        if (this.source) {
            try {
                this.source.stop();
                this.source.disconnect();
            } catch (e) {
                // Ignore
            }
            this.source = null;
        }
        this.isPlaying = false;
    }
}
