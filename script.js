import { AudioDatabase, AudioMetadata } from './AudioDatabase.js';
import { AudioProcessor } from './AudioProcessor.js';
import { AudioRenderer } from './AudioRenderer.js';
import { AudioPlaybackEngine } from './AudioPlaybackEngine.js';
import { PeerConnection } from './PeerConnection.js';

document.addEventListener('DOMContentLoaded', async () => {
    const uploadButton = document.getElementById('upload-btn');
    const downloadButton = document.getElementById('download-btn');
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
    canvas.addEventListener('playback-start', (e) => {
        if (playbackEngine.isPlaying) {
            playbackEngine.stop();
        } else {
            const { tracks, startTime, duration } = e.detail;
            playbackEngine.play(tracks, startTime, duration);
        }
    });

    canvas.addEventListener('playback-solo', (e) => {
        if (playbackEngine.isPlaying) {
            playbackEngine.stop();
        } else {
            const { track, startTime } = e.detail;
            if (track) playbackEngine.play([track], startTime);
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
                const { peaks } = await processor.process(file, audioCtx);

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
