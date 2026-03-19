const md = document.getElementById('md');
const out = document.getElementById('out');
function parse(v){
  return v
    .replace(/^# (.*)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}
function render(){ out.innerHTML = parse(md.value); }
md.addEventListener('input', render);
render();
