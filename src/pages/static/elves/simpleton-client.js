import elf from 'peersky://static/elves/elf.js'
import * as braid from '@braid/braid-http'
import { diff_main } from '@braid/myers-diff'
import { simpleton_client } from '@braid/simpleton-client'

self.braid_fetch = braid.fetch

const $ = elf('simpleton-client')

$.draw((target) => {
  const tag = target.getAttribute('tag') || 'textarea'

  if(!target.simpleton) {
    const resource = target.getAttribute('src')
    // no mime, just be a clown ok
    target.innerHTML = `
      <${tag} class="client"></${tag}>
    `
    target.texty = target.querySelector(tag)

    target.simpleton = simpleton_client(resource, {
      apply_remote_update: ({ state, patches }) => {
        if (state !== undefined) target.texty.value = state;
        else apply_patches_and_update_selection(target.texty, patches);
        const text = target.texty.value
        sync(target, text)
        return text;
      },
      generate_local_diff_update: (prev_state) => {
        var patches = diff(prev_state, target.texty.value);
        if (patches.length === 0) return null;
        const text = target.texty.value
        sync(target, text)
        return { patches, new_state: text };
      },
    });
  }
})

async function sync(target, text) {
  const root = target.closest($.link) || target.closest('.'+$.link)
  const { action, script } = root.dataset

  if(script) {
    const dispatch = (await import(script))[action]
    if(dispatch) {
      self.history.pushState({ action, script }, "");
      await dispatch(target, text)
    }
  }

}

$.when('input', '.client', (event) => {
  const adult = event.target.closest($.link)
  adult.simpleton.changed()
})

function diff(before, after) {
  let diff = diff_main(before, after);
  let patches = [];
  let offset = 0;
  for (let d of diff) {
    let p = null;
    if (d[0] == 1) p = { range: [offset, offset], content: d[1] };
    else if (d[0] == -1) {
      p = { range: [offset, offset + d[1].length], content: "" };
      offset += d[1].length;
    } else offset += d[1].length;
    if (p) {
      p.unit = "text";
      patches.push(p);
    }
  }
  return patches;
}

function apply_patches_and_update_selection(textarea, patches) {
  let offset = 0;
  for (let p of patches) {
    p.range[0] += offset;
    p.range[1] += offset;
    offset -= p.range[1] - p.range[0];
    offset += p.content.length;
  }

  let original = textarea.value;
  let sel = [textarea.selectionStart, textarea.selectionEnd];

  for (var p of patches) {
    let range = p.range;

    for (let i = 0; i < sel.length; i++)
      if (sel[i] > range[0])
        if (sel[i] > range[1]) sel[i] -= range[1] - range[0];
        else sel[i] = range[0];

    for (let i = 0; i < sel.length; i++)
      if (sel[i] > range[0]) sel[i] += p.content.length;

    original =
      original.substring(0, range[0]) +
      p.content +
      original.substring(range[1]);
  }

  textarea.value = original;
  textarea.selectionStart = sel[0];
  textarea.selectionEnd = sel[1];
}

function apply_mime_on_update(mime, target, patches) {
  if(patches.length === 0) return
  let offset = 0;
  for (const p of patches) {
    p.range[0] += offset;
    p.range[1] += offset;
    offset -= p.range[1] - p.range[0];
    offset += p.content.length;
  }

  let original = target.texty.dataset.value;

  for (const p of patches) {
    const range = p.range;

    original =
      original.substring(0, range[0]) +
      p.content +
      original.substring(range[1]);
  }

  target.texty.dataset.value = original;
  target.texty.innerHTML = mime(original)
}

$.style(`
  & {
    min-height: 10rem;
    position: relative;
    z-index: 2;
    display: block;
    max-width: 100%;
    overflow: auto;
    height: 100%;
    width: 100%;
  }

  & input {
    border: none;
    background: rgba(255,255,255,1);
    color: black;
  }
  & textarea {
    background: rgba(255,255,255,1);
    color: black;
    display: block;
    width: 100%;
    height: 100%;
    resize: none;
    border: none;
    padding: 1rem;
    line-height: 1.5;
    position: relative;
    z-index: 3;
    background-position-y: -1px;
  }

  &[data-view="insert"] {
    height: 100%;
    display: block;
  }
  &[data-view="insert"] input {
    display: none;
  }
`)

