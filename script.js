import { AudioDatabase, AudioMetadata } from './AudioDatabase.js';
import { AudioProcessor } from './AudioProcessor.js';
import { AudioRenderer } from './AudioRenderer.js';
import { AudioPlaybackEngine } from './AudioPlaybackEngine.js';
import { PeerConnection } from './PeerConnection.js';
import { RecordingEngine } from './RecordingEngine.js';
import { VUMeter } from './VUMeter.js';

document.addEventListener('DOMContentLoaded', async () => {
    const uploadButton = document.getElementById('upload-btn');
    const downloadButton = document.getElementById('download-btn');
    const audioInputBtn = document.getElementById('audio-input-btn');
    const audioOutputBtn = document.getElementById('audio-output-btn');
    const directoryPicker = document.getElementById('directory-picker');
    const peerLink = document.getElementById('peer-link');
    const peerStatus = document.getElementById('peer-status');
    const canvas = document.getElementById('daw-canvas');

    // Initialize Core Components
    const db = new AudioDatabase();
    const processor = new AudioProcessor();
    const renderer = new AudioRenderer(canvas);
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const playbackEngine = new AudioPlaybackEngine(audioCtx, db);
    const recordingEngine = new RecordingEngine(audioCtx, db, processor, renderer);

    // Initialize VU Meters
    const inputVUMeter = new VUMeter('input-vu-meter', null);
    const outputVUMeter = new VUMeter('output-vu-meter', playbackEngine.analyserNode);

    // 1. Open Database
    try {
        await db.open();
    } catch (err) {
        console.error('Failed to open database:', err);
    }

    // 2. Load Persisted State (render existing tracks)
    try {
        const storedTracks = await db.getAllMetadata();
        if (storedTracks.length > 0) {
            // Sort by trackIndex to maintain order
            storedTracks.sort((a, b) => (a.trackIndex || 0) - (b.trackIndex || 0));
            storedTracks.forEach(meta => renderer.addTrack(meta));
            console.log(`Restored ${storedTracks.length} tracks from database.`);
        }
    } catch (err) {
        console.error('Error loading existing tracks:', err);
    }

    // 3. Initialize Peer Connection
    const peerConnection = new PeerConnection();
    peerConnection.init();

    // 4. Initialize Audio Devices
    async function initAudioDevices() {
        try {
            // Request permissions first to get device labels, with specific constraints
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: false,
                        autoGainControl: false,
                        noiseSuppression: false
                    }
                });
                stream.getTracks().forEach(track => track.stop());
            } catch (err) {
                console.warn('Microphone permission not granted or available:', err);
            }

            const devices = await navigator.mediaDevices.enumerateDevices();
            
            // Clear existing options except the first placeholder
            audioInputBtn.innerHTML = '<option value="">Audio Input</option>';
            audioOutputBtn.innerHTML = '<option value="">Audio Output</option>';

            let hasInput = false;
            devices.forEach(device => {
                if (device.kind === 'audioinput') {
                    const option = document.createElement('option');
                    option.value = device.deviceId;
                    option.text = device.label || `Microphone ${audioInputBtn.length}`;
                    audioInputBtn.appendChild(option);
                    hasInput = true;
                } else if (device.kind === 'audiooutput') {
                    const option = document.createElement('option');
                    option.value = device.deviceId;
                    option.text = device.label || `Speaker ${audioOutputBtn.length}`;
                    audioOutputBtn.appendChild(option);
                }
            });

            // Auto-select the first available input
            if (hasInput && audioInputBtn.selectedIndex === 0) {
                audioInputBtn.selectedIndex = 1;
            }

            // If an input is selected, initialize the recording engine with it
            if (audioInputBtn.value) {
                await recordingEngine.setInputDevice(audioInputBtn.value);
                inputVUMeter.setAnalyser(recordingEngine.analyserNode);
            }
        } catch (err) {
            console.error('Error accessing media devices:', err);
        }
    }

    // Call it once to populate
    initAudioDevices();

    // Listen for device changes (e.g., plugging in a USB mic)
    navigator.mediaDevices.addEventListener('devicechange', initAudioDevices);

    // Handle manual input device selection
    audioInputBtn.addEventListener('change', async (e) => {
        await recordingEngine.setInputDevice(e.target.value);
        inputVUMeter.setAnalyser(recordingEngine.analyserNode);
    });

    document.addEventListener('peer-id-ready', (e) => {
        const { id, isHost, targetId } = e.detail;
        const url = new URL(window.location);
        url.searchParams.set('id', isHost ? id : targetId);
        peerLink.href = url.toString();
        peerLink.textContent = url.toString();
        peerStatus.textContent = isHost ? '(Host)' : '(Connecting to Host...)';
    });

    document.addEventListener('peer-connected', (e) => {
        peerStatus.textContent = '(Connected)';
        peerStatus.style.color = 'green';
    });

    document.addEventListener('peer-disconnected', (e) => {
        peerStatus.textContent = '(Disconnected)';
        peerStatus.style.color = 'red';
    });

    /**
     * --- Upload Logic ---
     * Triggers a hidden file input that's configured to select directories.
     */
    uploadButton.addEventListener('click', () => {
        directoryPicker.click();
    });

    /**
     * --- Playback Logic ---
     */
    canvas.addEventListener('playback-start', async (e) => {
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }
        if (playbackEngine.isPlaying || recordingEngine.isRecording) {
            console.log('Stopping playback and recording...');
            playbackEngine.stop();
            await recordingEngine.stopRecording();
        } else {
            console.log('Starting playback and recording...');
            const { tracks, startTime, duration } = e.detail;
            const masterStartTime = await playbackEngine.play(tracks, startTime, duration);
            recordingEngine.startRecording(startTime, masterStartTime);
        }
    });

    canvas.addEventListener('playback-solo', async (e) => {
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }
        if (playbackEngine.isPlaying || recordingEngine.isRecording) {
            playbackEngine.stop();
            await recordingEngine.stopRecording();
        } else {
            const { track, startTime } = e.detail;
            if (track) await playbackEngine.play([track], startTime);
        }
    });

    canvas.addEventListener('tracks-updated', async (e) => {
        const { tracks } = e.detail;
        try {
            for (const track of tracks) {
                await db.saveMetadata(track);
            }
            console.log('Saved updated track positions to database.');
        } catch (err) {
            console.error('Failed to save track positions:', err);
        }
    });

    /**
     * When a directory is selected, iterate through its files, load them into DB,
     * generate peaks, and render them.
     */
    directoryPicker.addEventListener('change', async (event) => {
        const files = Array.from(event.target.files).filter(file =>
            file.name.toLowerCase().endsWith('.wav') || file.name.toLowerCase().endsWith('.mp3')
        );

        if (files.length === 0) return;

        console.log(`Processing ${files.length} audio files...`);

        for (const file of files) {
            try {
                // 1. Check if file exists in DB and is unchanged
                const existingMeta = await db.getMetadata(file.name);

                if (existingMeta &&
                    existingMeta.size === file.size &&
                    existingMeta.lastModified === file.lastModified &&
                    existingMeta.renderCache) {

                    console.log(`Skipping ${file.name} (already cached).`);

                    // Ensure it's visible in the renderer
                    const isRendered = renderer.tracks.some(t => t.filename === file.name);
                    if (!isRendered) {
                        renderer.addTrack(existingMeta);
                    }
                    continue;
                }

                console.log(`Importing ${file.name}...`);

                // 2. Read raw file buffer for storage
                const arrayBuffer = await file.arrayBuffer();

                // 3. Save raw binary to AudioDatabase (audio_buffers store)
                await db.saveAudioBuffer(file.name, arrayBuffer);

                // 4. Process Audio (Decode & Generate Peaks)
                // We pass the File object; AudioProcessor handles decoding.
                const { peaks, decodedAudio } = await processor.process(file, audioCtx);

                // 4.5 Save decoded audio to bypass decoding on playback
                await db.saveDecodedAudio(file.name, decodedAudio);

                // 5. Create Metadata Object
                const trackIndex = renderer.tracks.length;
                const metadata = new AudioMetadata(
                    file.name,
                    file.size,
                    file.lastModified,
                    0, // Start Time
                    trackIndex,
                    peaks
                );

                // 6. Save Metadata to AudioDatabase (project_metadata store)
                await db.saveMetadata(metadata);

                // 7. Render to Canvas
                renderer.addTrack(metadata);

            } catch (err) {
                console.error(`Error processing ${file.name}:`, err);
            }
        }

        // Reset input
        directoryPicker.value = '';
        console.log('Upload complete.');
    });

    /**
     * --- Placeholder Logic ---
     * Adds console logs for other UI elements to confirm they are wired up.
     */
    downloadButton.addEventListener('click', () => console.log('Download button clicked.'));
});
