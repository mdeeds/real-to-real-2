export class VUMeter {
    constructor(canvasId, analyserNode) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.analyserNode = analyserNode;
        this.dataArray = new Uint8Array(256); // Default fftSize is 256, so frequencyBinCount is 128, but we can just use 256 to be safe.
        this.animationId = null;
        this.start();
    }

    setAnalyser(analyserNode) {
        this.analyserNode = analyserNode;
        if (this.analyserNode) {
            this.dataArray = new Uint8Array(this.analyserNode.frequencyBinCount);
        }
    }

    start() {
        const draw = () => {
            if (!this.canvas) return;

            const width = this.canvas.width;
            const height = this.canvas.height;

            this.ctx.clearRect(0, 0, width, height);

            let targetVolume = 0;
            if (this.analyserNode) {
                this.analyserNode.getByteTimeDomainData(this.dataArray);
                let sum = 0;
                for (let i = 0; i < this.dataArray.length; i++) {
                    const val = (this.dataArray[i] - 128) / 128;
                    sum += val * val;
                }
                const rms = Math.sqrt(sum / this.dataArray.length);
                // Convert RMS to a 0-1 scale, emphasizing lower volumes
                targetVolume = Math.min(1, rms * 5); 
            }

            // Smooth volume
            this.currentVolume = this.currentVolume || 0;
            this.currentVolume += (targetVolume - this.currentVolume) * 0.2;

            // Draw background
            this.ctx.fillStyle = '#333';
            this.ctx.fillRect(0, 0, width, height);

            // Draw meter
            const meterHeight = this.currentVolume * height;
            
            // Gradient from green to red
            const gradient = this.ctx.createLinearGradient(0, height, 0, 0);
            gradient.addColorStop(0, '#0f0');
            gradient.addColorStop(0.7, '#ff0');
            gradient.addColorStop(1, '#f00');

            this.ctx.fillStyle = gradient;
            this.ctx.fillRect(0, height - meterHeight, width, meterHeight);

            this.animationId = requestAnimationFrame(draw);
        };

        this.animationId = requestAnimationFrame(draw);
    }

    stop() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }
}
