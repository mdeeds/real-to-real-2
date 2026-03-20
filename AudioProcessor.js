/**
 * Module for processing raw audio data into AudioBuffers and visualization peaks.
 * Handles decoding and granular analysis for waveform rendering.
 */
export class AudioProcessor {
    /**
     * Processes input audio data to generate an AudioBuffer and pre-calculated peaks.
     * 
     * @param {Float32Array|AudioBuffer|Blob} input - The source audio data.
     * @param {AudioContext} audioCtx - The Web Audio API context used for decoding or buffer creation.
     * @returns {Promise<{audioBuffer: AudioBuffer, peaks: Object}>} 
     *          Returns an object containing the decoded AudioBuffer and a 'peaks' object 
     *          with keys '1', '10', and '100' representing ms resolution.
     */
    async process(input, audioCtx) {
        let audioBuffer;

        // 1. Normalize input to AudioBuffer
        if (input instanceof Blob) {
            const arrayBuffer = await input.arrayBuffer();
            audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        } else if (input instanceof AudioBuffer) {
            audioBuffer = input;
        } else if (input instanceof Float32Array) {
            // Assume raw Float32Array is mono. 
            // Use the context's sampleRate since raw arrays don't carry that info.
            audioBuffer = audioCtx.createBuffer(1, input.length, audioCtx.sampleRate);
            audioBuffer.copyToChannel(input, 0);
        } else {
            throw new Error("Invalid input type. Expected Float32Array, AudioBuffer, or Blob.");
        }

        // 2. Prepare data for analysis (mixdown to mono if necessary)
        const monoData = this._getMonoData(audioBuffer);
        const sampleRate = audioBuffer.sampleRate;

        // 3. Generate Peak objects at 1ms, 10ms, and 100ms granularity
        const peaks = {
            '1': this._generatePeaks(monoData, sampleRate, 0.001),
            '10': this._generatePeaks(monoData, sampleRate, 0.010),
            '100': this._generatePeaks(monoData, sampleRate, 0.100)
        };

        return { audioBuffer, peaks };
    }

    /**
     * Extracts channel data or mixes down multiple channels to mono for analysis.
     * @param {AudioBuffer} buffer 
     * @returns {Float32Array}
     */
    _getMonoData(buffer) {
        if (buffer.numberOfChannels === 1) {
            return buffer.getChannelData(0);
        }

        const length = buffer.length;
        const channels = buffer.numberOfChannels;
        const mono = new Float32Array(length);
        const channelData = [];

        // Cache channel references
        for (let c = 0; c < channels; c++) {
            channelData.push(buffer.getChannelData(c));
        }

        // Average across channels
        for (let i = 0; i < length; i++) {
            let sum = 0;
            for (let c = 0; c < channels; c++) {
                sum += channelData[c][i];
            }
            mono[i] = sum / channels;
        }

        return mono;
    }

    /**
     * Calculates Min, Max, and RMS values for the given resolution.
     * @param {Float32Array} data - Raw audio samples.
     * @param {number} sampleRate - Sample rate of the data.
     * @param {number} resolutionSeconds - Duration of each chunk in seconds.
     * @returns {Object} Object containing { min, max, rms } Float32Arrays.
     */
    _generatePeaks(data, sampleRate, resolutionSeconds) {
        const step = Math.floor(sampleRate * resolutionSeconds);
        const steps = Math.ceil(data.length / step);

        const minVals = new Float32Array(steps);
        const maxVals = new Float32Array(steps);
        const rmsVals = new Float32Array(steps);

        for (let i = 0; i < steps; i++) {
            const start = i * step;
            const end = Math.min(start + step, data.length);

            let min = 0;
            let max = 0;
            let sumSq = 0;

            for (let j = start; j < end; j++) {
                const val = data[j];
                if (val < min) min = val;
                if (val > max) max = val;
                sumSq += val * val;
            }

            minVals[i] = min;
            maxVals[i] = max;
            rmsVals[i] = Math.sqrt(sumSq / (end - start));
        }

        return { min: minVals, max: maxVals, rms: rmsVals };
    }
}