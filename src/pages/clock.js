class Clock extends HTMLElement {
    constructor() {
        super();
        this.updateTime();
    }

    connectedCallback() {
        this.render();
        this.startClock();
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
