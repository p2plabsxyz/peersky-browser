class Clock extends HTMLElement {
    constructor() {
        super();
        this.updateTime();
        this.isVisible = true; // Default state
        this.clockFormat = window.electronAPI?.getClockFormatSync?.() || '24h';
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

                this.electronAPI.onClockFormatChanged?.((format) => {
                    console.log('Clock: format changed to:', format);
                    this.clockFormat = format;
                    this.render();
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

            const clockFormat = await this.electronAPI.settings.get('clockFormat');
            this.clockFormat = clockFormat || '24h';
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
        this.style.fontSize = "48px";
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
        let hours = date.getHours();
        const minutes = String(date.getMinutes()).padStart(2, "0");

        if (this.clockFormat === '12h') {
            const period = hours >= 12 ? 'PM' : 'AM';
            hours = hours % 12 || 12;
            return `${hours}:${minutes} ${period}`;
        }

        return `${String(hours).padStart(2, "0")}:${minutes}`;
    }
}

customElements.define("simple-clock", Clock);
