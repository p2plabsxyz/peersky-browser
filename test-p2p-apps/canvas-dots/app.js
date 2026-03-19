const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let t = 0;
function frame() {
  t += 0.02;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < 80; i += 1) {
    const x = (i * 31 + Math.sin(t + i) * 200 + 300) % canvas.width;
    const y = (i * 19 + Math.cos(t * 1.2 + i) * 150 + 200) % canvas.height;
    ctx.fillStyle = `hsl(${(i * 17 + t * 120) % 360} 80% 60%)`;
    ctx.beginPath();
    ctx.arc(x, y, 3 + (i % 4), 0, Math.PI * 2);
    ctx.fill();
  }
  requestAnimationFrame(frame);
}
frame();
