/**
 * @class RecordProcessor
 * @extends AudioWorkletProcessor
 */
class RecorderWorklet extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufferSize = 128 * 4; // 4 render quantums
        this.buffers = [];
        this.framesCollected = 0;
        this.batchStartFrame = 0;
        this.batchStartTime = 0;
    }

    /**
     * The main processing function. It's called for each block of 128 audio frames.
     * @param {Float32Array[][]} inputs - Array of inputs, each with an array of channels.
     * @returns {boolean} - `true` to keep the processor alive.
     */
    process(inputs) {
        // We assume the first input is the one we want to record.
        const input = inputs[0];

        // If there are zero inputs or the input has no channels, just return.
        if (!input || input.length === 0) {
            return true;
        }

        const numChannels = input.length;
        const sampleLength = input[0].length;

        // Initialize or re-initialize buffers if channel count changes
        if (this.buffers.length !== numChannels) {
            this.buffers = [];
            for (let i = 0; i < numChannels; i++) {
                this.buffers.push(new Float32Array(this.bufferSize));
            }
            // Reset collection if format changes
            this.framesCollected = 0;
        }

        if (this.framesCollected === 0) {
            // This is the first quantum in a new batch, so store the start time.
            this.batchStartFrame = currentFrame;
            this.batchStartTime = currentTime;
        }

        // Copy each channel's data into the corresponding buffer
        for (let i = 0; i < numChannels; i++) {
            this.buffers[i].set(input[i], this.framesCollected);
        }

        this.framesCollected += sampleLength;

        if (this.framesCollected >= this.bufferSize) {
            const buffersToSend = this.buffers;

            // Buffer is full, calculate stats and send it.
            this.port.postMessage({
                type: 'samples',
                channels: buffersToSend,
                startFrame: this.batchStartFrame,
                startTimeS: this.batchStartTime,
            }, buffersToSend.map(b => b.buffer));

            // Create a new buffer for the next batch and reset the counter.
            this.buffers = [];
            for (let i = 0; i < numChannels; i++) {
                this.buffers.push(new Float32Array(this.bufferSize));
            }
            this.framesCollected = 0;
        }

        // Keep the processor alive.
        return true;
    }
}

registerProcessor('record-processor', RecorderWorklet);