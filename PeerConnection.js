import Peer from 'peerjs';

export class PeerConnection {
    constructor() {
        this.peer = null;
        this.connections = [];
    }

    generateId() {
        const letters = 'abcdefghijklmnopqrstuvwxyz';
        let id = '';
        for (let i = 0; i < 3; i++) {
            id += letters.charAt(Math.floor(Math.random() * letters.length));
        }
        id += '-';
        for (let i = 0; i < 4; i++) {
            id += Math.floor(Math.random() * 10);
        }
        return id;
    }

    init() {
        const urlParams = new URLSearchParams(window.location.search);
        let targetId = urlParams.get('id');

        if (!targetId && window.location.search.length > 1) {
            const raw = window.location.search.substring(1);
            if (/^[a-z]{3}-\d{4}$/.test(raw)) {
                targetId = raw;
            }
        }

        if (targetId) {
            this.connectToHost(targetId);
        } else {
            this.startHostSession(this.generateId());
        }
    }

    startHostSession(id) {
        this.peer = new Peer(id);

        this.peer.on('open', (peerId) => {
            console.log('Host session started with ID:', peerId);
            const url = new URL(window.location);
            url.searchParams.set('id', peerId);
            window.history.replaceState({}, '', url);
            
            document.dispatchEvent(new CustomEvent('peer-id-ready', { detail: { id: peerId, isHost: true } }));
        });

        this.peer.on('connection', (conn) => {
            console.log('New connection from:', conn.peer);
            this.connections.push(conn);
            this.setupConnection(conn);
        });

        this.peer.on('error', (err) => {
            console.error('PeerJS error:', err);
            if (err.type === 'unavailable-id') {
                this.peer.destroy();
                this.startHostSession(this.generateId());
            }
        });
    }

    connectToHost(targetId) {
        this.peer = new Peer();

        this.peer.on('open', (peerId) => {
            console.log('Client initialized. Connecting to host:', targetId);
            document.dispatchEvent(new CustomEvent('peer-id-ready', { detail: { id: peerId, isHost: false, targetId } }));

            const conn = this.peer.connect(targetId);
            this.connections.push(conn);
            this.setupConnection(conn);
        });

        this.peer.on('error', (err) => {
            if (err.type === 'peer-unavailable') {
                console.log('Target ID not found. Starting session as host:', targetId);
                this.peer.destroy();
                this.startHostSession(targetId);
            } else {
                console.error('PeerJS error:', err);
            }
        });
    }

    setupConnection(conn) {
        conn.on('open', () => {
            console.log('Connection opened with:', conn.peer);
            document.dispatchEvent(new CustomEvent('peer-connected', { detail: { peerId: conn.peer } }));
        });

        conn.on('data', (data) => {
            console.log('Received data from', conn.peer, ':', data);
            document.dispatchEvent(new CustomEvent('peer-data-received', { detail: { peerId: conn.peer, data } }));
        });

        conn.on('close', () => {
            console.log('Connection closed with:', conn.peer);
            this.connections = this.connections.filter(c => c !== conn);
            document.dispatchEvent(new CustomEvent('peer-disconnected', { detail: { peerId: conn.peer } }));
        });
    }

    sendData(data) {
        this.connections.forEach(conn => {
            if (conn.open) {
                conn.send(data);
            }
        });
    }
}
