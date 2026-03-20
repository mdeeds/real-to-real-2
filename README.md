# Real-to-Real

Realtime reel-to-reel peer-to-peer. A radically simple, browser-based Digital Audio Workstation designed for aligning multi-track WAV files and syncing them without a backend server.

Built entirely with vanilla JavaScript, the Web Audio API, and WebRTC (via PeerJS). No build steps, no bundlers, no installers.

**Use it now:** [https://mdeeds.github.io/real-to-real](https://mdeeds.github.io/real-to-real)

## How to Use

This DAW is optimized for keyboard-centric navigation and manual latency alignment.

### 1. Loading Audio

**Click the Upload button** and select a local directory.

The browser will load all `.wav` files in that folder. They will appear as new tracks starting at 0:00.

> **Note:** Files are stored in your browser's local IndexedDB. They will persist across page reloads.

### 2. Navigation & Zoom

The viewport is strictly controlled by three fixed zoom levels to ensure pixel-perfect rendering and navigation. Zooming is always centered on your mouse cursor.

*   **`1`**: 1ms per pixel (High detail, tracks are 30px high).
*   **`2`**: 10ms per pixel (Medium detail, tracks are 20px high).
*   **`3`**: 100ms per pixel (Overview, tracks are 10px high).
*   **`+`/`-`**: Change between the three levels of detail.
*   **Left Arrow / Right Arrow**: Pan the view by 1/4 of the visible area.
*   **Home**: Jump to the beginning of the timeline (0:00).
*   **End**: Jump to the end of the longest audio track.
*   **`S`**: Solo playback of the track under the mouse cursor starting from the mouse position.
*   **`M`**: Mute the track under the mouse cursor.

### 3. Editing & Alignment

*   **Move in Time**: Click and drag a waveform left or right to adjust its start time.
*   **Reorder Tracks**: Click and drag a waveform up or down to change its track order.
*   **Transient Alignment (Sync Guide)**: Hold `Ctrl` and click anywhere on the screen. This drops a vertical guide line across all tracks at that exact point in time, allowing you to manually drag other waveforms to align transients and account for hardware latency.
*   **Delete Track**: Click on a track to select it, then press `Del`.

### 4. Playback & Recording

Press the **Spacebar** to begin playback from the left edge of the current screen. The behavior changes based on your zoom level:

*   **Zoom Level 1 (1ms/px - Edit Mode)**: Playback does not scroll the screen. It only plays what is currently visible in the viewport and stops when the playhead reaches the right edge.
*   **Zoom Levels 2 & 3 (10ms/100ms - Record Mode)**: The screen scrolls to follow the playhead. **Note:** In this mode, playback automatically begins recording a new track from your system's default audio input.

### 5. Peer-to-Peer Sync

You can synchronize your project state and WAV files directly to another computer over the internet, with no central server storing your data.

*   **Connect**: Copy your "Peer ID" from the top right and paste it into the "Connect to Peer" box on the second computer.
*   **Upload (Push)**: Clicking "Upload" creates a manifest of your current local directory. Only files that are new or have changed (based on file size and modification date) will be sent to the connected peer.
*   **Download (Pull)**: Clicking "Download" compares your local files against the connected peer's files. It will only download the delta (files you are missing or that have been updated).

## Architecture & Implementation

This project is built using vanilla JavaScript ES6 Modules, avoiding modern build tools (Webpack, Vite) and import statements entirely, relying instead on a clean, global-scoped module pattern for rapid prototyping.

### Audio Engine

*   **Web Audio API**: Audio playback is handled entirely by `AudioContext`.
*   **Decoding**: WAV files are read as `ArrayBuffers` and decoded natively using `audioCtx.decodeAudioData()`.
*   **Scheduling**: Playback uses `AudioBufferSourceNode.start(when, offset)`. Manual time shifts (dragging a clip) simply update the track's `startTime` metadata, allowing sample-accurate scheduling without destructive audio editing.

### Canvas Rendering & Anti-Aliasing

To prevent aliasing ("sparkling") when scrolling through densely packed waveform data, the application uses a strict decimation strategy tied to the three locked zoom levels.

When a WAV file is loaded, three parallel `Float32Array` data structures are pre-calculated:

1.  **1ms resolution**: Chunks of ~44 samples (assuming 44.1kHz).
2.  **10ms resolution**: Chunks of ~441 samples.
3.  **100ms resolution**: Chunks of ~4410 samples.

For each chunk, the engine calculates the Min, Max, and RMS values. The `<canvas>` renderer uses the `currentZoomIdx` to select the appropriate pre-calculated array. It draws a vertical line from min to max for each pixel, ensuring high-frequency peaks are never skipped regardless of the zoom level.

### IndexedDB Storage Architecture

To handle potentially gigabytes of audio data without crashing the browser or exceeding `localStorage` quotas, the application utilizes IndexedDB with a two-store schema:

**`project_metadata` Store**: Contains lightweight JSON objects representing the DAW state. Querying this store is extremely fast.

*   **Key**: `filename`
*   **Value**: `{ size, lastModified, startTime, trackIndex, renderCache }` (The `renderCache` holds the pre-calculated min/max/rms `Float32Array`s).

**`audio_buffers` Store**: Contains the heavy binary data. These are only loaded into memory when decoding is required.

*   **Key**: `filename`
*   **Value**: Raw `ArrayBuffer` of the .wav file.

When the application loads, it immediately reads `project_metadata` to draw the UI and waveforms from the `renderCache`. The actual `audio_buffers` are fetched asynchronously when playback is triggered.

### P2P Sync & Chunking Mechanism

Synchronization is achieved via PeerJS, establishing a WebRTC DataChannel.

**State Reconciliation:**

1.  **Metadata Profiling**: When a file is selected, the app reads the `File` object's name, size, and `lastModified` properties. It does not read the binary file contents into memory.
2.  **Manifest Exchange**: Peers exchange JSON manifests containing the metadata from their respective `project_metadata` stores.
3.  **Diffing**: The receiving browser compares remote file sizes and timestamps against its local store, requesting only the files that mismatch.

**Binary Data Chunking:**

WebRTC DataChannels have strict message size limits (often maxing out around 16KB to 64KB depending on the browser implementation). Attempting to send a 50MB WAV file in a single message will crash the channel. The application implements a custom chunking protocol:

*   **Header Message**: The sender transmits a JSON header:
    ```json
    { "type": "FILE_START", "filename": "vocal.wav", "totalChunks": 1500, "byteLength": 45000000 }
    ```

*   **Chunking Loop**: The sender slices the `ArrayBuffer` into 16KB to 32KB pieces. It sends each piece sequentially:
    ```json
    { "type": "CHUNK", "index": 0, "data": ArrayBufferSlice }
    ```

*   **Reassembly**: The receiver temporarily holds these chunks in an array.
*   **Completion**: Upon receiving a `{ type: 'FILE_END' }` message, the receiver allocates a single large `Uint8Array` based on the `byteLength`, copies all chunks into it in order, and commits the final `ArrayBuffer` to the `audio_buffers` IndexedDB store.