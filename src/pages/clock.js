class Clock extends HTMLElement {
    constructor() {
        super();
        this.updateTime();
        this.isVisible = true; // Default state
        this.setupIPC();
    }

    connectedCallback() {
        this.render();
        this.startClock();
        this.loadInitialSettings();
    }

    setupIPC() {
        // Use electronAPI exposed by unified-preload.js
        if (window.electronAPI) {
            this.electronAPI = window.electronAPI;
            
            // Listen for show-clock-changed events
            try {
                this.electronAPI.onShowClockChanged((showClock) => {
                    console.log('Clock: Show clock setting changed to:', showClock);
                    this.setVisibility(showClock);
                });
            } catch (error) {
                console.error('Clock: Failed to set up event listener:', error);
            }
        } else {
            console.warn('Clock: electronAPI not available, clock toggle will not work');
        }
    }

    async loadInitialSettings() {
        if (!this.electronAPI) {
            console.warn('Clock: electronAPI not available, using default visibility');
            return;
        }

        try {
            const showClock = await this.electronAPI.settings.get('showClock');
            console.log('Clock: Initial showClock setting:', showClock);
            this.setVisibility(showClock);
        } catch (error) {
            console.error('Clock: Failed to load initial settings:', error);
            // Keep default visibility on error
        }
    }

    setVisibility(visible) {
        this.isVisible = visible;
        this.style.display = visible ? 'block' : 'none';
        console.log('Clock: Visibility set to:', visible ? 'visible' : 'hidden');
    }

    render() {
        this.style.position = "absolute";
        this.style.top = "20px";
        this.style.right = "20px";
        this.style.color = "#FFFFFF";
        this.style.fontFamily = "'Helvetica Neue', Arial, sans-serif";
        this.style.fontSize = "30px";
        this.style.fontWeight = "200";
        this.style.padding = "8px";
        this.style.borderRadius = "12px";
        this.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
        this.style.backdropFilter = "blur(10px) saturate(180%)";
        this.style.border = "1px solid rgba(255, 255, 255, 0.2)";
        this.style.boxShadow = "0 4px 10px rgba(0, 0, 0, 0.2)";
        this.textContent = this.formatTime(this.currentTime);
    }

    startClock() {
        setInterval(() => {
            this.updateTime();
            this.render();
        }, 1000);
    }

    updateTime() {
        this.currentTime = new Date();
    }

    formatTime(date) {
        const hours = String(date.getHours()).padStart(2, "0");
        const minutes = String(date.getMinutes()).padStart(2, "0");
        return `${hours}:${minutes}`;
    }
}

customElements.define("simple-clock", Clock);
