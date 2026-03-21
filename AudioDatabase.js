/**
 * Wrapper class for Project Metadata as described in the architecture.
 * Represents the lightweight state of a track without the heavy audio buffer.
 */
export class AudioMetadata {
    /**
     * @param {string} filename - Unique identifier for the file.
     * @param {number} size - File size in bytes.
     * @param {number} lastModified - Timestamp of last modification.
     * @param {number} [startTime=0] - Offset in seconds where playback begins.
     * @param {number} [trackIndex=0] - Vertical order of the track.
     * @param {Object} [renderCache=null] - Object containing pre-calculated Min/Max/RMS Float32Arrays.
     */
    constructor(filename, size, lastModified, startTime = 0, trackIndex = 0, renderCache = null) {
        this.filename = filename;
        this.size = size;
        this.lastModified = lastModified;
        this.startTime = startTime;
        this.trackIndex = trackIndex;
        this.renderCache = renderCache;
    }
}

/**
 * Manages the IndexedDB connection and transactions for the application.
 * Implements the two-store schema: 'project_metadata' and 'audio_buffers'.
 */
export class AudioDatabase {
    constructor() {
        this.dbName = 'real-to-real-db';
        this.dbVersion = 2;
        this.db = null;
    }

    /**
     * Opens the database connection and creates object stores if they don't exist.
     * @returns {Promise<void>}
     */
    async open() {
        if (this.db) return;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = (event) => {
                console.error('AudioDatabase open error:', event.target.error);
                reject(event.target.error);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Store 1: project_metadata
                // Contains lightweight JSON objects. Querying this is fast.
                if (!db.objectStoreNames.contains('project_metadata')) {
                    db.createObjectStore('project_metadata', { keyPath: 'filename' });
                }

                // Store 2: audio_buffers
                // Contains heavy binary ArrayBuffers. Only accessed when needed for decoding.
                // Uses out-of-line keys (filename) instead of keyPath for raw binary storage.
                if (!db.objectStoreNames.contains('audio_buffers')) {
                    db.createObjectStore('audio_buffers');
                }

                // Store 3: decoded_audio
                // Contains raw Float32Array channel data to bypass decoding on playback.
                if (!db.objectStoreNames.contains('decoded_audio')) {
                    db.createObjectStore('decoded_audio');
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve();
            };
        });
    }

    async getMetadata(filename) {
        return this._request('project_metadata', 'readonly', store => store.get(filename));
    }

    async getAllMetadata() {
        return this._request('project_metadata', 'readonly', store => store.getAll());
    }

    async saveMetadata(metadata) {
        return this._request('project_metadata', 'readwrite', store => store.put(metadata));
    }

    async deleteMetadata(filename) {
        return this._request('project_metadata', 'readwrite', store => store.delete(filename));
    }

    async getAudioBuffer(filename) {
        return this._request('audio_buffers', 'readonly', store => store.get(filename));
    }

    async saveAudioBuffer(filename, buffer) {
        return this._request('audio_buffers', 'readwrite', store => store.put(buffer, filename));
    }

    async getDecodedAudio(filename) {
        return this._request('decoded_audio', 'readonly', store => store.get(filename));
    }

    async saveDecodedAudio(filename, decodedData) {
        return this._request('decoded_audio', 'readwrite', store => store.put(decodedData, filename));
    }

    /**
     * Internal helper to wrap IDBRequest in a Promise.
     * @param {string} storeName 
     * @param {string} mode - 'readonly' or 'readwrite'
     * @param {Function} callback - Function receiving the store, should return an IDBRequest.
     */
    _request(storeName, mode, callback) {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                return reject(new Error('Database is not open. Call open() first.'));
            }

            const transaction = this.db.transaction(storeName, mode);
            const store = transaction.objectStore(storeName);

            try {
                const request = callback(store);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            } catch (err) {
                reject(err);
            }
        });
    }
}