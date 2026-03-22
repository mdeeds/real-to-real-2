# Real-to-Real

Realtime reel-to-reel peer-to-peer. A radically simple, browser-based Digital Audio Workstation designed for
recording, aligning multi-track WAV files, and mixing them in a spatial environment without a backend server.

Built entirely with vanilla JavaScript, the Web Audio API, and WebRTC (via PeerJS). No build steps, no bundlers,
no installers.

## Features & How to Use

### 1. Loading & Recording Audio

*   **Upload Directory**: Click the **Upload** button and select a local directory. The browser will load all `.wav` files in that folder.
*   **Record**: Select your input device from the dropdown. Press the **Spacebar** to begin playback and recording simultaneously.
*   **Metronome**: Toggle the metronome and adjust the BPM. Your BPM setting is automatically saved to your browser's local storage.
*   **Persistence**: All recorded and uploaded audio is saved locally in your browser using IndexedDB. It will persist across page reloads.

### 2. Timeline View (Default)

The default view is a traditional multi-track timeline optimized for manual latency alignment.

*   **Zoom Levels**: Use `1`, `2`, `3`, or `+`/`-` to switch between 1ms, 10ms, and 100ms per pixel zoom levels.
*   **Navigation**: Use the **Left/Right Arrow** keys to pan the view, or **Home** to jump to the beginning (0:00).
*   **Move in Time**: Click and drag a waveform left or right to adjust its start time.
*   **Reorder Tracks**: Click and drag a waveform up or down to change its track order.
*   **Solo**: Hover over a track and press `S` to solo it from the mouse position.
*   **Delete**: Hover over a track and press `Delete` or `Backspace` to remove it. An **Undo** button will appear if you make a mistake.

### 3. Spatial Audio View

Press **`Tab`** to switch from the Timeline view to the Spatial Audio view. This mode allows you to visually mix your tracks in a 2D space.

*   **Tracks as Nodes**: Each track is represented as a colored circle.
*   **Panning (X-Axis)**: Drag a circle left or right to adjust its stereo panning.
*   **Filtering (Y-Axis)**: Drag a circle up or down to apply filters:
    *   **Top Half (High-Pass Filter)**: Dragging upwards increases the HPF cutoff frequency logarithmically up to 20kHz, cutting out low frequencies.
    *   **Center**: Both filters are wide open (unfiltered).
    *   **Bottom Half (Low-Pass Filter)**: Dragging downwards decreases the LPF cutoff frequency logarithmically down to 20Hz, cutting out high frequencies.
    *   **Guidelines**: Dashed lines indicate 200Hz and 2000Hz cutoffs for precise mixing.
*   **Solo**: Hover over a node and press `S` to solo it.

### 4. Peer-to-Peer Sync

Synchronize your project state and WAV files directly to another computer over the internet, with no central server storing your data.

*   **Connect**: Share the unique URL provided at the top of the screen with another user.
*   **Upload (Push)**: Clicking "Upload" creates a manifest of your current local directory and sends new/changed files to the connected peer.
*   **Download (Pull)**: Clicking "Download" compares your local files against the connected peer's files and downloads the delta.

## Architecture & Implementation

### Audio Engine

*   **Web Audio API**: Audio playback is handled entirely by `AudioContext`.
*   **Recording**: Utilizes `AudioWorklet` for glitch-free, low-latency audio capture directly from the microphone.
*   **Spatial Mixing**: Each track is routed through a dynamic node chain: `BufferSource -> Gain -> Highpass (BiquadFilter) -> Lowpass (BiquadFilter) -> StereoPanner -> Master`.
*   **Scheduling**: Playback uses `AudioBufferSourceNode.start(when, offset)`. Manual time shifts simply update the track's `startTime` metadata.

### Canvas Rendering & Anti-Aliasing

To prevent aliasing ("sparkling") when scrolling through densely packed waveform data, the application uses a strict decimation strategy. When a WAV file is loaded or recorded, three parallel `Float32Array` data structures are pre-calculated for 1ms, 10ms, and 100ms resolutions. The `<canvas>` renderer uses the current zoom level to select the appropriate pre-calculated array, drawing a vertical line from min to max for each pixel.

### IndexedDB Storage Architecture

To handle potentially gigabytes of audio data without crashing the browser, the application utilizes IndexedDB with a two-store schema:

1.  **`project_metadata`**: Contains lightweight JSON objects representing the DAW state (start times, pan, filter frequencies, and pre-calculated waveform peaks).
2.  **`audio_buffers`**: Contains the heavy binary `ArrayBuffer` data of the .wav files, loaded into memory only when decoding is required for playback.

### P2P Sync & Chunking Mechanism

Synchronization is achieved via PeerJS, establishing a WebRTC DataChannel. Because WebRTC DataChannels have strict message size limits, the application implements a custom chunking protocol to slice large `ArrayBuffers` into smaller pieces (e.g., 16KB-32KB) for transmission, reassembling them on the receiving end before committing them to IndexedDB.
