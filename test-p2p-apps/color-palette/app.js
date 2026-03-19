const root = document.getElementById('swatches');
const rand = () => '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
function generate() {
  root.innerHTML = '';
  for (let i = 0; i < 10; i += 1) {
    const c = rand();
    const d = document.createElement('div');
    d.className = 'sw';
    d.style.background = c;
    d.title = c;
    root.appendChild(d);
  }
}
document.getElementById('btn').addEventListener('click', generate);
generate();
