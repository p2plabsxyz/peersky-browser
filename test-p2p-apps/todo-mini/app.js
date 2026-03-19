const key = 'todo-mini-items';
let items = JSON.parse(localStorage.getItem(key) || '[]');
const list = document.getElementById('list');
function save(){ localStorage.setItem(key, JSON.stringify(items)); }
function render(){
  list.innerHTML='';
  items.forEach((txt, i)=>{
    const li=document.createElement('li');
    li.textContent=txt;
    const b=document.createElement('button');
    b.textContent='Done'; b.className='done';
    b.onclick=()=>{ items.splice(i,1); save(); render(); };
    li.appendChild(b); list.appendChild(li);
  });
}
document.getElementById('f').addEventListener('submit', (e)=>{
  e.preventDefault(); const t=document.getElementById('t');
  if(!t.value.trim()) return; items.push(t.value.trim()); t.value=''; save(); render();
});
render();
