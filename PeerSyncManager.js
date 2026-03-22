export class PeerSyncManager {
    constructor(peerConnection, db, renderer, processor, audioCtx, playbackEngine) {
        this.peerConnection = peerConnection;
        this.db = db;
        this.renderer = renderer;
        this.processor = processor;
        this.audioCtx = audioCtx;
        this.playbackEngine = playbackEngine;
        
        this.incomingFiles = new Map(); // filename -> { chunks: [], totalChunks: 0, byteLength: 0 }
        
        this.setupListeners();
    }

    setupListeners() {
        document.addEventListener('peer-connected', async (e) => {
            console.log('[PeerSync] Peer connected, sending manifest...');
            await this.sendManifest();
        });

        document.addEventListener('peer-data-received', async (e) => {
            const { peerId, data } = e.detail;
            await this.handleData(peerId, data);
        });

        // Listen for local changes to broadcast
        this.renderer.canvas.addEventListener('tracks-updated', async (e) => {
            const { tracks } = e.detail;
            this.broadcastMetadataUpdate(tracks);
        });

        this.renderer.canvas.addEventListener('track-deleted', async (e) => {
            const { track } = e.detail;
            this.broadcastTrackDeleted(track.filename);
        });
        
        document.addEventListener('recording-saved', async (e) => {
            const { metadata } = e.detail;
            // When a new recording is saved, we can just send a new manifest or notify peers
            await this.sendManifest();
        });

        document.addEventListener('upload-complete', async () => {
            await this.sendManifest();
        });

        document.addEventListener('track-restored', async () => {
            await this.sendManifest();
        });
    }

    async sendManifest() {
        try {
            const tracks = await this.db.getAllMetadata();
            const manifest = tracks.map(t => ({
                filename: t.filename,
                size: t.size,
                lastModified: t.lastModified,
                startTime: t.startTime,
                trackIndex: t.trackIndex,
                pan: t.pan,
                hpFreq: t.hpFreq,
                lpFreq: t.lpFreq,
                peaks: t.renderCache // Send peaks so the other side can render immediately
            }));

            this.peerConnection.sendData({
                type: 'SYNC_MANIFEST',
                manifest
            });
        } catch (err) {
            console.error('[PeerSync] Error sending manifest:', err);
        }
    }

    broadcastMetadataUpdate(tracks) {
        const updates = tracks.map(t => ({
            filename: t.filename,
            startTime: t.startTime,
            trackIndex: t.trackIndex,
            pan: t.pan,
            hpFreq: t.hpFreq,
            lpFreq: t.lpFreq
        }));

        this.peerConnection.sendData({
            type: 'UPDATE_METADATA',
            updates
        });
    }

    broadcastTrackDeleted(filename) {
        this.peerConnection.sendData({
            type: 'TRACK_DELETED',
            filename
        });
    }

    async handleData(peerId, data) {
        if (!data || !data.type) return;

        switch (data.type) {
            case 'SYNC_MANIFEST':
                await this.handleManifest(data.manifest);
                break;
            case 'REQUEST_FILE':
                await this.sendFile(data.filename);
                break;
            case 'FILE_START':
                this.handleFileStart(data);
                break;
            case 'FILE_CHUNK':
                this.handleFileChunk(data);
                break;
            case 'FILE_END':
                await this.handleFileEnd(data);
                break;
            case 'UPDATE_METADATA':
                await this.handleMetadataUpdate(data.updates);
                break;
            case 'TRACK_DELETED':
                await this.handleTrackDeleted(data.filename);
                break;
        }
    }

    async handleManifest(remoteManifest) {
        console.log(`[PeerSync] Received manifest with ${remoteManifest.length} tracks.`);
        
        for (const remoteTrack of remoteManifest) {
            const localTrack = await this.db.getMetadata(remoteTrack.filename);
            
            if (!localTrack) {
                console.log(`[PeerSync] Track ${remoteTrack.filename} is missing locally. Requesting...`);
                
                // Save the metadata immediately so we can render the placeholder/peaks
                // We'll mark it as not downloaded, but we have the peaks from the manifest
                const newMeta = {
                    ...remoteTrack,
                    renderCache: remoteTrack.peaks,
                    isDownloaded: false
                };
                await this.db.saveMetadata(newMeta);
                
                // Add to renderer
                const isRendered = this.renderer.tracks.some(t => t.filename === newMeta.filename);
                if (!isRendered) {
                    this.renderer.addTrack(newMeta);
                }

                // Request the actual audio file
                this.peerConnection.sendData({
                    type: 'REQUEST_FILE',
                    filename: remoteTrack.filename
                });
            } else {
                // Check if we need to update metadata (e.g. they moved it)
                // For simplicity, we'll just accept their metadata if it differs in startTime etc.
                // In a real app, you'd want conflict resolution based on timestamps.
                let updated = false;
                
                const remotePan = remoteTrack.pan || 0;
                const remoteHpFreq = remoteTrack.hpFreq || 20;
                const remoteLpFreq = remoteTrack.lpFreq || 20000;
                const localPan = localTrack.pan || 0;
                const localHpFreq = localTrack.hpFreq || 20;
                const localLpFreq = localTrack.lpFreq || 20000;

                if (localTrack.startTime !== remoteTrack.startTime || 
                    localTrack.trackIndex !== remoteTrack.trackIndex ||
                    localPan !== remotePan ||
                    localHpFreq !== remoteHpFreq ||
                    localLpFreq !== remoteLpFreq) {
                    
                    localTrack.startTime = remoteTrack.startTime;
                    localTrack.trackIndex = remoteTrack.trackIndex;
                    localTrack.pan = remotePan;
                    localTrack.hpFreq = remoteHpFreq;
                    localTrack.lpFreq = remoteLpFreq;
                    
                    await this.db.saveMetadata(localTrack);
                    updated = true;
                }
                
                if (updated) {
                    // Update renderer
                    const renderTrack = this.renderer.tracks.find(t => t.filename === localTrack.filename);
                    if (renderTrack) {
                        renderTrack.startTime = localTrack.startTime;
                        renderTrack.trackIndex = localTrack.trackIndex;
                        renderTrack.pan = localTrack.pan;
                        renderTrack.hpFreq = localTrack.hpFreq;
                        renderTrack.lpFreq = localTrack.lpFreq;
                    }
                    this.playbackEngine.updateTrackNodes(localTrack.filename, localTrack.pan, localTrack.hpFreq, localTrack.lpFreq);
                    this.renderer.draw();
                }
            }
        }
    }

    async handleMetadataUpdate(updates) {
        for (const update of updates) {
            const localTrack = await this.db.getMetadata(update.filename);
            if (localTrack) {
                localTrack.startTime = update.startTime;
                localTrack.trackIndex = update.trackIndex;
                localTrack.pan = update.pan || 0;
                localTrack.hpFreq = update.hpFreq || 20;
                localTrack.lpFreq = update.lpFreq || 20000;
                
                await this.db.saveMetadata(localTrack);
                
                const renderTrack = this.renderer.tracks.find(t => t.filename === localTrack.filename);
                if (renderTrack) {
                    renderTrack.startTime = localTrack.startTime;
                    renderTrack.trackIndex = localTrack.trackIndex;
                    renderTrack.pan = localTrack.pan;
                    renderTrack.hpFreq = localTrack.hpFreq;
                    renderTrack.lpFreq = localTrack.lpFreq;
                }
                this.playbackEngine.updateTrackNodes(localTrack.filename, localTrack.pan, localTrack.hpFreq, localTrack.lpFreq);
            }
        }
        this.renderer.draw();
    }

    async handleTrackDeleted(filename) {
        await this.db.deleteMetadata(filename);
        this.renderer.tracks = this.renderer.tracks.filter(t => t.filename !== filename);
        this.renderer.draw();
        
        this.playbackEngine.deleteTrackNodes(filename);
    }

    async sendFile(filename) {
        console.log(`[PeerSync] Sending file ${filename}...`);
        const arrayBuffer = await this.db.getAudioBuffer(filename);
        if (!arrayBuffer) {
            console.error(`[PeerSync] Could not find audio buffer for ${filename}`);
            return;
        }

        const chunkSize = 16384; // 16KB chunks
        const totalChunks = Math.ceil(arrayBuffer.byteLength / chunkSize);

        this.peerConnection.sendData({
            type: 'FILE_START',
            filename,
            totalChunks,
            byteLength: arrayBuffer.byteLength
        });

        for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, arrayBuffer.byteLength);
            const chunk = arrayBuffer.slice(start, end);

            this.peerConnection.sendData({
                type: 'FILE_CHUNK',
                filename,
                index: i,
                data: chunk
            });
            
            // Small delay to prevent flooding the data channel
            if (i % 10 === 0) {
                await new Promise(r => setTimeout(r, 1));
            }
        }

        this.peerConnection.sendData({
            type: 'FILE_END',
            filename
        });
        console.log(`[PeerSync] Finished sending ${filename}`);
    }

    handleFileStart(data) {
        this.incomingFiles.set(data.filename, {
            chunks: new Array(data.totalChunks),
            totalChunks: data.totalChunks,
            byteLength: data.byteLength,
            receivedChunks: 0
        });
        console.log(`[PeerSync] Receiving file ${data.filename} (${data.byteLength} bytes)...`);
    }

    handleFileChunk(data) {
        const fileInfo = this.incomingFiles.get(data.filename);
        if (fileInfo) {
            fileInfo.chunks[data.index] = data.data;
            fileInfo.receivedChunks++;
        }
    }

    async handleFileEnd(data) {
        const fileInfo = this.incomingFiles.get(data.filename);
        if (!fileInfo) return;

        console.log(`[PeerSync] Reassembling ${data.filename}...`);
        
        const finalBuffer = new Uint8Array(fileInfo.byteLength);
        let offset = 0;
        for (const chunk of fileInfo.chunks) {
            if (chunk) {
                finalBuffer.set(new Uint8Array(chunk), offset);
                offset += chunk.byteLength;
            }
        }

        // Save raw binary
        await this.db.saveAudioBuffer(data.filename, finalBuffer.buffer);
        
        // Decode and save decoded audio
        try {
            // Create a File object to pass to processor
            const file = new File([finalBuffer.buffer], data.filename, { type: 'audio/wav' });
            const { decodedAudio } = await this.processor.process(file, this.audioCtx);
            await this.db.saveDecodedAudio(data.filename, decodedAudio);
            console.log(`[PeerSync] Successfully processed and saved ${data.filename}`);
        } catch (err) {
            console.error(`[PeerSync] Error decoding received file ${data.filename}:`, err);
        }

        this.incomingFiles.delete(data.filename);
    }
}
