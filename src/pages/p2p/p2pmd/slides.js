class SlidesPresentation {
  constructor(markdown) {
    this.markdown = markdown;
    this.slides = [];
    this.currentSlide = 0;
    this.parseSlides();
  }

  parseSlides() {
    const slideDelimiters = /^---$|^<!-- slide -->$/gm;
    const parts = this.markdown.split(slideDelimiters);
    
    this.slides = parts
      .map(slide => slide.trim())
      .filter(slide => slide.length > 0);
  }

  getCurrentSlide() {
    return this.slides[this.currentSlide] || '';
  }

  nextSlide() {
    if (this.currentSlide < this.slides.length - 1) {
      this.currentSlide++;
      return true;
    }
    return false;
  }

  prevSlide() {
    if (this.currentSlide > 0) {
      this.currentSlide--;
      return true;
    }
    return false;
  }

  goToSlide(index) {
    if (index >= 0 && index < this.slides.length) {
      this.currentSlide = index;
      return true;
    }
    return false;
  }

  getTotalSlides() {
    return this.slides.length;
  }

  getProgress() {
    return this.slides.length > 0 
      ? ((this.currentSlide + 1) / this.slides.length) * 100 
      : 0;
  }
}

function createSlidesHTML(markdown, renderMarkdown) {
  const presentation = new SlidesPresentation(markdown);
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Presentation Slides</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #1a1a1a;
      color: #ffffff;
      overflow: hidden;
      height: 100vh;
      width: 100vw;
    }

    #slides-container {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .slide {
      display: none;
      width: 90%;
      max-width: 1200px;
      height: 85%;
      padding: 3rem;
      background: #ffffff;
      color: #1a1a1a;
      border-radius: 8px;
      box-shadow: 0 10px 50px rgba(0, 0, 0, 0.5);
      overflow-y: auto;
      animation: slideIn 0.3s ease-out;
    }

    .slide.active {
      display: block;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateX(20px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }

    .slide h1 {
      font-size: 3rem;
      margin-bottom: 1.5rem;
      color: #1a1a1a;
    }

    .slide h2 {
      font-size: 2.2rem;
      margin: 1.5rem 0 1rem;
      color: #333;
    }

    .slide h3 {
      font-size: 1.6rem;
      margin: 1.2rem 0 0.8rem;
      color: #444;
    }

    .slide p {
      font-size: 1.3rem;
      line-height: 1.8;
      margin-bottom: 1rem;
      color: #333;
    }

    .slide ul, .slide ol {
      font-size: 1.3rem;
      line-height: 1.8;
      margin-left: 2rem;
      margin-bottom: 1rem;
    }

    .slide li {
      margin-bottom: 0.5rem;
    }

    .slide pre {
      background: #2d2d2d;
      color: #f8f8f2;
      padding: 1.5rem;
      border-radius: 6px;
      overflow-x: auto;
      margin: 1rem 0;
      font-size: 1.1rem;
    }

    .slide code {
      font-family: 'FontWithASyntaxHighlighter', 'Courier New', monospace;
      background: #2d2d2d;
      color: #f8f8f2;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 1.1rem;
    }

    .slide pre code {
      background: transparent;
      padding: 0;
    }

    .slide blockquote {
      border-left: 4px solid #0066cc;
      padding-left: 1.5rem;
      margin: 1rem 0;
      font-style: italic;
      color: #555;
    }

    .slide img {
      max-width: 100%;
      height: auto;
      border-radius: 6px;
      margin: 1rem 0;
    }

    .slide a {
      color: #0066cc;
      text-decoration: none;
    }

    .slide a:hover {
      text-decoration: underline;
    }

    .nav-arrow {
      position: fixed;
      top: 50%;
      transform: translateY(-50%);
      background: rgba(255, 255, 255, 0.1);
      border: none;
      color: #ffffff;
      font-size: 3rem;
      width: 80px;
      height: 80px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
      z-index: 100;
      backdrop-filter: blur(10px);
    }

    .nav-arrow:hover {
      background: rgba(255, 255, 255, 0.2);
      transform: translateY(-50%) scale(1.1);
    }

    .nav-arrow:active {
      transform: translateY(-50%) scale(0.95);
    }

    .nav-arrow.disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    .nav-arrow.disabled:hover {
      background: rgba(255, 255, 255, 0.1);
      transform: translateY(-50%) scale(1);
    }

    #prev-arrow {
      left: 2rem;
    }

    #next-arrow {
      right: 2rem;
    }

    #progress-bar {
      position: fixed;
      bottom: 0;
      left: 0;
      height: 4px;
      background: #0066cc;
      transition: width 0.3s ease;
      z-index: 101;
    }

    #slide-counter {
      position: fixed;
      bottom: 1rem;
      right: 2rem;
      background: rgba(0, 0, 0, 0.6);
      color: #ffffff;
      padding: 0.5rem 1rem;
      border-radius: 20px;
      font-size: 0.9rem;
      backdrop-filter: blur(10px);
      z-index: 100;
    }

    @media (max-width: 768px) {
      .slide {
        width: 95%;
        height: 90%;
        padding: 2rem;
      }

      .slide h1 {
        font-size: 2rem;
      }

      .slide h2 {
        font-size: 1.6rem;
      }

      .slide p, .slide ul, .slide ol {
        font-size: 1.1rem;
      }

      .nav-arrow {
        width: 60px;
        height: 60px;
        font-size: 2rem;
      }

      #prev-arrow {
        left: 1rem;
      }

      #next-arrow {
        right: 1rem;
      }
    }
  </style>
</head>
<body>
  <div id="slides-container"></div>
  
  <button id="prev-arrow" class="nav-arrow" aria-label="Previous slide">‹</button>
  <button id="next-arrow" class="nav-arrow" aria-label="Next slide">›</button>
  
  <div id="progress-bar"></div>
  <div id="slide-counter"></div>

  <script>
    const slidesData = ${JSON.stringify(presentation.slides)};
    let currentSlide = 0;

    function renderMarkdown(markdown) {
      // Simple markdown parser - replace with your actual renderMarkdown function
      return markdown
        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
        .replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>')
        .replace(/\*(.*)\*/gim, '<em>$1</em>')
        .replace(/\`\`\`([\\s\\S]*?)\`\`\`/gim, '<pre><code>$1</code></pre>')
        .replace(/\`([^\`]+)\`/gim, '<code>$1</code>')
        .replace(/^> (.*$)/gim, '<blockquote>$1</blockquote>')
        .replace(/^- (.*$)/gim, '<li>$1</li>')
        .replace(/(<li>.*<\\/li>)/s, '<ul>$1</ul>')
        .replace(/^\\d+\\. (.*$)/gim, '<li>$1</li>')
        .replace(/\\n/gim, '<br>');
    }

    function renderSlides() {
      const container = document.getElementById('slides-container');
      container.innerHTML = '';
      
      slidesData.forEach((slideContent, index) => {
        const slideDiv = document.createElement('div');
        slideDiv.className = 'slide';
        if (index === currentSlide) {
          slideDiv.classList.add('active');
        }
        slideDiv.innerHTML = renderMarkdown(slideContent);
        container.appendChild(slideDiv);
      });
      
      updateUI();
    }

    function updateUI() {
      const progress = ((currentSlide + 1) / slidesData.length) * 100;
      document.getElementById('progress-bar').style.width = progress + '%';
      document.getElementById('slide-counter').textContent = 
        (currentSlide + 1) + ' / ' + slidesData.length;
      
      const prevBtn = document.getElementById('prev-arrow');
      const nextBtn = document.getElementById('next-arrow');
      
      if (currentSlide === 0) {
        prevBtn.classList.add('disabled');
      } else {
        prevBtn.classList.remove('disabled');
      }
      
      if (currentSlide === slidesData.length - 1) {
        nextBtn.classList.add('disabled');
      } else {
        nextBtn.classList.remove('disabled');
      }
    }

    function showSlide(index) {
      if (index < 0 || index >= slidesData.length) return;
      
      const slides = document.querySelectorAll('.slide');
      slides[currentSlide].classList.remove('active');
      currentSlide = index;
      slides[currentSlide].classList.add('active');
      updateUI();
    }

    function nextSlide() {
      if (currentSlide < slidesData.length - 1) {
        showSlide(currentSlide + 1);
      }
    }

    function prevSlide() {
      if (currentSlide > 0) {
        showSlide(currentSlide - 1);
      }
    }

    document.getElementById('prev-arrow').addEventListener('click', prevSlide);
    document.getElementById('next-arrow').addEventListener('click', nextSlide);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        prevSlide();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') {
        e.preventDefault();
        nextSlide();
      } else if (e.key === 'Home') {
        showSlide(0);
      } else if (e.key === 'End') {
        showSlide(slidesData.length - 1);
      }
    });

    // Click on right/left half of screen to navigate
    document.getElementById('slides-container').addEventListener('click', (e) => {
      const clickX = e.clientX;
      const windowWidth = window.innerWidth;
      
      if (clickX < windowWidth / 2) {
        prevSlide();
      } else {
        nextSlide();
      }
    });

    renderSlides();
  </script>
</body>
</html>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SlidesPresentation, createSlidesHTML };
}
