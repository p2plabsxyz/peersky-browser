const key = 'hello-notes-text';
const note = document.getElementById('note');
note.value = localStorage.getItem(key) || '';
note.addEventListener('input', () => localStorage.setItem(key, note.value));
