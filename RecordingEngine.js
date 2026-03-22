import { AudioMetadata } from './AudioDatabase.js';

export class RecordingEngine {
    constructor(audioCtx, db, processor, renderer) {
        this.audioCtx = audioCtx;
        this.db = db;
        this.processor = processor;
        this.renderer = renderer;
        
        this.workletNode = null;
        this.mediaStreamSource = null;
        this.stream = null;
        
        this.isRecording = false;
        
        this.preRollChunks = [];
        this.recordedChunks = [];
        
        // 1 second of pre-roll at 48kHz with 512 frames per chunk is ~94 chunks.
        // We'll keep up to 100 chunks.
        this.maxPreRollChunks = 100; 
        
        this.timelineStartTime = 0;
        this.masterStartTime = 0;
        this.lastLogTime = 0;
        
        this.workletPromise = this.initWorklet();
    }

    async initWorklet() {
        try {
            await this.audioCtx.audioWorklet.addModule('RecorderWorklet.js');
            console.log('[RecordingEngine] RecorderWorklet loaded successfully.');
        } catch (err) {
            console.error('[RecordingEngine] Failed to load RecorderWorklet:', err);
        }
    }

    async setInputDevice(deviceId) {
        await this.workletPromise; // Ensure worklet is loaded before creating node

        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
        }
        if (this.mediaStreamSource) {
            this.mediaStreamSource.disconnect();
        }
        if (this.workletNode) {
            this.workletNode.disconnect();
        }

        if (!deviceId) return;

        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: { exact: deviceId },
                    echoCancellation: false,
                    autoGainControl: false,
                    noiseSuppression: false
                }
            });

            this.mediaStreamSource = this.audioCtx.createMediaStreamSource(this.stream);
            this.analyserNode = this.audioCtx.createAnalyser();
            this.analyserNode.fftSize = 256;
            this.mediaStreamSource.connect(this.analyserNode);

            this.workletNode = new AudioWorkletNode(this.audioCtx, 'record-processor');
            
            this.workletNode.port.onmessage = (e) => this.handleMessage(e);
            
            this.analyserNode.connect(this.workletNode);
            
            // Connect to destination via a silent gain node to keep the worklet running
            const silentGain = this.audioCtx.createGain();
            silentGain.gain.value = 0;
            this.workletNode.connect(silentGain);
            silentGain.connect(this.audioCtx.destination);

            this.preRollChunks = [];
            console.log(`[RecordingEngine] Input device set to ${deviceId}`);
        } catch (err) {
            console.error('[RecordingEngine] Error setting input device:', err);
        }
    }

    handleMessage(event) {
        const now = performance.now();
        if (now - this.lastLogTime >= 10000) {
            console.log('[RecordingEngine] Raw packet from worklet:', event.data);
            this.lastLogTime = now;
        }

        if (event.data.type === 'samples') {
            const { channels, startFrame, startTimeS } = event.data;
            
            if (this.isRecording) {
                this.recordedChunks.push({ channels, startFrame, startTimeS });
            } else {
                this.preRollChunks.push({ channels, startFrame, startTimeS });
                if (this.preRollChunks.length > this.maxPreRollChunks) {
                    this.preRollChunks.shift();
                }
            }
        }
    }

    startRecording(timelineStartTime, masterStartTime) {
        if (!this.workletNode) {
            console.warn('Cannot start recording: No microphone selected or worklet not initialized.');
            return;
        }
        
        this.isRecording = true;
        this.timelineStartTime = timelineStartTime;
        this.masterStartTime = masterStartTime;
        
        // Move pre-roll chunks to recorded chunks
        this.recordedChunks = [...this.preRollChunks];
        this.preRollChunks = [];
        console.log(`[RecordingEngine] Started recording at timeline ${timelineStartTime}s. Pre-roll chunks: ${this.recordedChunks.length}`);
    }

    async stopRecording() {
        if (!this.isRecording) {
            console.log('[RecordingEngine] stopRecording called, but isRecording is false.');
            return;
        }
        this.isRecording = false;
        
        if (this.recordedChunks.length === 0) {
            console.warn('[RecordingEngine] Stopped recording, but no chunks were recorded.');
            return;
        }
        
        console.log(`[RecordingEngine] Stopped recording. Total chunks to process: ${this.recordedChunks.length}`);
        
        const chunksToProcess = this.recordedChunks;
        this.recordedChunks = [];
        
        // Calculate the exact start time on the timeline
        // The first chunk has a startTimeS (AudioContext time).
        // The playback started at masterStartTime (AudioContext time) which corresponds to timelineStartTime (Timeline time).
        // So the first chunk's timeline time is:
        // timelineStartTime + (firstChunk.startTimeS - masterStartTime)
        
        const firstChunk = chunksToProcess[0];
        let exactTimelineStartTime = this.timelineStartTime + (firstChunk.startTimeS - this.masterStartTime);
        
        // Apply latency adjustment if configured
        const savedLatency = localStorage.getItem('recording_latency_ms');
        if (savedLatency) {
            const latencyMs = parseFloat(savedLatency);
            if (!isNaN(latencyMs)) {
                exactTimelineStartTime -= (latencyMs / 1000);
            }
        }
        
        // Process recorded chunks into a WAV file
        const wavBlob = this.createWavBlob(chunksToProcess, this.audioCtx.sampleRate);
        
        // Create a File object
        const filename = `Recording_${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
        const file = new File([wavBlob], filename, { type: 'audio/wav', lastModified: Date.now() });
        
        try {
            // Save raw binary to AudioDatabase
            const arrayBuffer = await file.arrayBuffer();
            await this.db.saveAudioBuffer(file.name, arrayBuffer);

            console.log(`[RecordingEngine] Processing audio for ${filename}...`);
            
            // Reconstruct Float32Arrays directly from chunks to bypass WAV decoding issues
            const numChannels = chunksToProcess[0].channels.length;
            const numSamples = chunksToProcess.reduce((acc, chunk) => acc + chunk.channels[0].length, 0);
            const channelData = [];
            
            for (let c = 0; c < numChannels; c++) {
                const arr = new Float32Array(numSamples);
                let offset = 0;
                for (const chunk of chunksToProcess) {
                    arr.set(chunk.channels[c], offset);
                    offset += chunk.channels[c].length;
                }
                channelData.push(arr);
            }
            
            const rawDecodedAudio = {
                sampleRate: this.audioCtx.sampleRate,
                length: numSamples,
                numberOfChannels: numChannels,
                channels: channelData
            };

            // Process Audio (Generate Peaks from raw data)
            const { peaks, decodedAudio } = this.processor.processDecoded(rawDecodedAudio);

            console.log(`[RecordingEngine] Saving decoded audio to DB...`);
            await this.db.saveDecodedAudio(file.name, decodedAudio);

            const trackIndex = this.renderer.tracks.length;
            const metadata = new AudioMetadata(
                file.name,
                file.size,
                file.lastModified,
                exactTimelineStartTime, // Allow negative start times for pre-roll before 0
                trackIndex,
                peaks
            );

            console.log(`[RecordingEngine] Saving metadata to DB...`);
            await this.db.saveMetadata(metadata);
            
            console.log(`[RecordingEngine] Adding track to renderer...`);
            this.renderer.addTrack(metadata);
            
            console.log(`[RecordingEngine] Recording successfully saved and added to timeline at ${exactTimelineStartTime}s`);
            
            document.dispatchEvent(new CustomEvent('recording-saved', { detail: { metadata } }));
        } catch (err) {
            console.error('[RecordingEngine] Error saving recording:', err);
        }
    }

    createWavBlob(chunks, sampleRate) {
        const numChannels = chunks[0].channels.length;
        const numSamples = chunks.reduce((acc, chunk) => acc + chunk.channels[0].length, 0);
        
        const buffer = new ArrayBuffer(44 + numSamples * numChannels * 2);
        const view = new DataView(buffer);
        
        const writeString = (view, offset, string) => {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        };
        
        writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + numSamples * numChannels * 2, true);
        writeString(view, 8, 'WAVE');
        writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // 1 = PCM
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * numChannels * 2, true);
        view.setUint16(32, numChannels * 2, true);
        view.setUint16(34, 16, true); // 16 bits per sample
        writeString(view, 36, 'data');
        view.setUint32(40, numSamples * numChannels * 2, true);
        
        let offset = 44;
        for (const chunk of chunks) {
            const channelData = chunk.channels;
            const length = channelData[0].length;
            for (let i = 0; i < length; i++) {
                for (let channel = 0; channel < numChannels; channel++) {
                    let sample = channelData[channel][i];
                    // Clamp sample to -1 to 1 to prevent clipping artifacts
                    sample = Math.max(-1, Math.min(1, sample));
                    // Convert to 16-bit PCM
                    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
                    offset += 2;
                }
            }
        }
        
        return new Blob([view], { type: 'audio/wav' });
    }
}
