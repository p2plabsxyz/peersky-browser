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
        this.style.fontFamily = "monospace";
        this.style.fontSize = "30px";
        this.style.padding = "5px";
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
