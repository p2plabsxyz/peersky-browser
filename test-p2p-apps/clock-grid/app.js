const el = document.getElementById('clock');
const render = () => {
  const d = new Date();
  el.textContent = d.toLocaleTimeString();
};
render();
setInterval(render, 1000);
