import { AudioDatabase, AudioMetadata } from './AudioDatabase.js';
import { AudioProcessor } from './AudioProcessor.js';
import { AudioRenderer } from './AudioRenderer.js';
import { AudioPlaybackEngine } from './AudioPlaybackEngine.js';
import { PeerConnection } from './PeerConnection.js';
import { PeerSyncManager } from './PeerSyncManager.js';
import { RecordingEngine } from './RecordingEngine.js';
import { VUMeter } from './VUMeter.js';
import { Metronome } from './Metronome.js';

document.addEventListener('DOMContentLoaded', async () => {
    const uploadButton = document.getElementById('upload-btn');
    const downloadButton = document.getElementById('download-btn');
    const resetBtn = document.getElementById('reset-btn');
    const audioInputBtn = document.getElementById('audio-input-btn');
    const audioOutputBtn = document.getElementById('audio-output-btn');
    const directoryPicker = document.getElementById('directory-picker');
    const peerLink = document.getElementById('peer-link');
    const peerStatus = document.getElementById('peer-status');
    const canvas = document.getElementById('daw-canvas');
    const timeDiffDisplay = document.getElementById('time-diff-display');
    const undoBtn = document.getElementById('undo-btn');
    const metronomeToggle = document.getElementById('metronome-toggle');
    const bpmInput = document.getElementById('bpm-input');
    const latencyInput = document.getElementById('latency-input');

    let lastDeletedTrack = null;

    // Initialize Core Components
    const db = new AudioDatabase();
    const processor = new AudioProcessor();
    const renderer = new AudioRenderer(canvas);
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const playbackEngine = new AudioPlaybackEngine(audioCtx, db);
    const recordingEngine = new RecordingEngine(audioCtx, db, processor, renderer);
    const metronome = new Metronome(audioCtx);
    metronome.connect(playbackEngine.masterGain);
    renderer.setMetronome(metronome);

    // Latency UI Listeners
    if (latencyInput) {
        const savedLatency = localStorage.getItem('recording_latency_ms');
        if (savedLatency) {
            latencyInput.value = savedLatency;
        }
        latencyInput.addEventListener('change', (e) => {
            localStorage.setItem('recording_latency_ms', e.target.value);
        });
    }

    // Metronome UI Listeners
    if (metronomeToggle) {
        metronomeToggle.addEventListener('change', (e) => {
            metronome.setEnabled(e.target.checked);
        });
    }
    if (bpmInput) {
        // Load saved BPM
        const savedBpm = localStorage.getItem('metronome_bpm');
        if (savedBpm) {
            const parsedBpm = parseInt(savedBpm, 10);
            if (!isNaN(parsedBpm) && parsedBpm > 0) {
                bpmInput.value = parsedBpm;
                metronome.setBpm(parsedBpm);
            }
        }

        bpmInput.addEventListener('change', (e) => {
            const bpm = parseInt(e.target.value, 10);
            if (!isNaN(bpm) && bpm > 0) {
                metronome.setBpm(bpm);
                localStorage.setItem('metronome_bpm', bpm.toString());
            }
        });
    }

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
    const peerSyncManager = new PeerSyncManager(peerConnection, db, renderer, processor, audioCtx, playbackEngine);

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
        const sessionId = isHost ? id : targetId;
        url.searchParams.set('id', sessionId);
        
        peerLink.href = '#';
        peerLink.textContent = sessionId;
        
        peerLink.onclick = (ev) => {
            ev.preventDefault();
            navigator.clipboard.writeText(url.toString()).then(() => {
                const originalText = peerLink.textContent;
                peerLink.textContent = 'Copied!';
                setTimeout(() => {
                    peerLink.textContent = originalText;
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy link: ', err);
            });
        };

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
     * --- Reset Logic ---
     * Drops the entire IndexedDB database and reloads the page.
     */
    if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
            try {
                await db.deleteEntireDatabase();
                console.log("Database deleted successfully.");
                window.location.reload();
            } catch (err) {
                console.error("Failed to delete database:", err);
            }
        });
    }

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
            metronome.stop();
            await recordingEngine.stopRecording();
        } else {
            console.log('Starting playback and recording...');
            const { tracks, startTime, duration } = e.detail;
            const masterStartTime = await playbackEngine.play(tracks, startTime, duration);
            recordingEngine.startRecording(startTime, masterStartTime);
            metronome.start(startTime, masterStartTime);
        }
    });

    canvas.addEventListener('playback-solo', async (e) => {
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }
        if (playbackEngine.isPlaying || recordingEngine.isRecording) {
            playbackEngine.stop();
            metronome.stop();
            await recordingEngine.stopRecording();
        } else {
            const { track, startTime } = e.detail;
            if (track) {
                const masterStartTime = await playbackEngine.play([track], startTime);
                metronome.start(startTime, masterStartTime);
            }
        }
    });

    canvas.addEventListener('track-spatial-update', async (e) => {
        const { track } = e.detail;
        playbackEngine.updateTrackNodes(track.filename, track.pan, track.hpFreq, track.lpFreq);
        // We don't save to DB on every mouse move to avoid spamming, 
        // but we save on 'tracks-updated' which fires on mouseup.
    });

    canvas.addEventListener('tracks-updated', async (e) => {
        const { tracks } = e.detail;
        try {
            for (const track of tracks) {
                track.version = (track.version || 1) + 1;
                track.updatedAt = Date.now();
                await db.saveMetadata(track);
            }
            console.log('Saved updated track positions to database.');
        } catch (err) {
            console.error('Failed to save track positions:', err);
        }
    });

    canvas.addEventListener('track-deleted', async (e) => {
        const { track } = e.detail;
        try {
            await db.deleteMetadata(track.filename);
            playbackEngine.deleteTrackNodes(track.filename);
            lastDeletedTrack = track;
            if (undoBtn) undoBtn.style.display = 'inline-block';
            console.log(`Deleted track ${track.filename} from database.`);
        } catch (err) {
            console.error('Failed to delete track:', err);
        }
    });

    if (undoBtn) {
        undoBtn.addEventListener('click', async () => {
            if (lastDeletedTrack) {
                try {
                    lastDeletedTrack.version = (lastDeletedTrack.version || 1) + 1;
                    lastDeletedTrack.updatedAt = Date.now();
                    await db.saveMetadata(lastDeletedTrack);
                    renderer.addTrack(lastDeletedTrack);
                    console.log(`Restored track ${lastDeletedTrack.filename}`);
                    document.dispatchEvent(new CustomEvent('track-restored', { detail: { track: lastDeletedTrack } }));
                    lastDeletedTrack = null;
                    undoBtn.style.display = 'none';
                } catch (err) {
                    console.error('Failed to restore track:', err);
                }
            }
        });
    }

    canvas.addEventListener('time-diff-updated', (e) => {
        if (timeDiffDisplay) {
            const diff = e.detail.diff;
            const sign = diff > 0 ? '+' : (diff < 0 ? '-' : '');
            timeDiffDisplay.textContent = sign + Math.abs(diff).toFixed(3);
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
                    peaks,
                    true // isDownloaded: mark uploaded files as already downloaded
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
        document.dispatchEvent(new CustomEvent('upload-complete'));
    });

    /**
     * --- Download Logic ---
     * Prompts the user for a directory and saves all audio files there.
     */
    downloadButton.addEventListener('click', async (e) => {
        const forceDownloadAll = e.ctrlKey || e.metaKey;

        try {
            // Check if the File System Access API is supported
            if (!window.showDirectoryPicker) {
                alert('Your browser does not support the File System Access API. Please use a modern browser like Chrome or Edge.');
                return;
            }

            const tracks = await db.getAllMetadata();
            if (tracks.length === 0) {
                alert('No tracks to download.');
                return;
            }

            // Ask user for a directory to save files
            const dirHandle = await window.showDirectoryPicker({
                mode: 'readwrite'
            });

            // Get list of existing files in the selected directory
            const existingFiles = new Set();
            for await (const entry of dirHandle.values()) {
                if (entry.kind === 'file') {
                    existingFiles.add(entry.name);
                }
            }

            console.log(`Checking ${tracks.length} files for download...`);

            let successCount = 0;
            let skippedCount = 0;

            for (const track of tracks) {
                try {
                    let shouldDownload = false;

                    if (forceDownloadAll) {
                        shouldDownload = true;
                    } else {
                        if (existingFiles.has(track.filename)) {
                            // File already exists in the folder. Skip downloading, but mark as downloaded in DB.
                            shouldDownload = false;
                            if (!track.isDownloaded) {
                                track.isDownloaded = true;
                                await db.saveMetadata(track);
                            }
                            skippedCount++;
                        } else if (track.isDownloaded) {
                            // Already marked as downloaded and we aren't forcing.
                            shouldDownload = false;
                            skippedCount++;
                        } else {
                            // Doesn't exist in folder, and not marked as downloaded.
                            shouldDownload = true;
                        }
                    }

                    if (shouldDownload) {
                        // Get the raw audio buffer from the database
                        const arrayBuffer = await db.getAudioBuffer(track.filename);
                        if (!arrayBuffer) {
                            console.warn(`Could not find audio buffer for ${track.filename}`);
                            continue;
                        }

                        // Create a file handle in the selected directory
                        const fileHandle = await dirHandle.getFileHandle(track.filename, { create: true });
                        
                        // Create a writable stream
                        const writable = await fileHandle.createWritable();
                        
                        // Write the ArrayBuffer to the file
                        await writable.write(arrayBuffer);
                        
                        // Close the file
                        await writable.close();
                        
                        console.log(`Successfully downloaded ${track.filename}`);
                        successCount++;

                        // Mark as downloaded in DB
                        if (!track.isDownloaded) {
                            track.isDownloaded = true;
                            await db.saveMetadata(track);
                        }
                    }
                } catch (err) {
                    console.error(`Failed to process ${track.filename}:`, err);
                }
            }
            
            console.log('Download process complete.');
            alert(`Downloaded ${successCount} files. Skipped ${skippedCount} files.`);
        } catch (err) {
            if (err.name === 'AbortError') {
                console.log('Download cancelled by user.');
            } else {
                console.error('Error during download:', err);
                alert('Failed to download files. See console for details.');
            }
        }
    });
});
