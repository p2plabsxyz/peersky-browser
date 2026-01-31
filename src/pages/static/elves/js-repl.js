import $elf from 'peersky://static/elves/elf.js'

// expects
// <script src="peersky://static/js/vendor/quickjs-emscripten/quickjs.js"></script>

const { getQuickJS } = self.QJS

async function main() {
  const QuickJS = await getQuickJS()
  const vm = QuickJS.newContext()

  const world = vm.newString("world")
  vm.setProp(vm.global, "NAME", world)
  world.dispose()

  const result = vm.evalCode(`"Hello " + NAME + "!"`)
  if (result.error) {
    console.log("Execution failed:", vm.dump(result.error))
    result.error.dispose()
  } else {
    console.log("Success:", vm.dump(result.value))
    result.value.dispose()
  }

  vm.dispose()
}

main()

const data = {
  input: `
/*
 * Congratulations, you've found java's crypt!
 *
 * this is a text based adventure game that is won by code.
 *
 */

// a function is a block of code that can be re-used
function hello() {
  return 'world'
}

// say hello from wherever in the world
hello()

// values
const a = 2;
const b = 3;
const c = 4;

const target = {
  score: 0
}

function score(x, count) {
  if(count) {
    x.score += count
  }

  return x.score
}

function formula(x, y, z) {
  return x * y + z
}

const views = {
  north: (target) => {
    return 'Forest blocks all directions. Except a beach to the SOUTH. And the WAFFLES above.'
  },
  south: (target) => {
    return 'Ocean blocks all directions. Except a meadow to the NORTH. And the WAFFLES above.'
  },
  waffles: (target) => {
    return 'You win. WAFFLES. (total score: ' + score(target) + ')'
  }
}

const commands = {
  north: (target) => {
  },
  south: (target) => {
  },
  waffles: (target) => {
    score(target, 1)
  }
}

function turn(command) {
  if(commands[command]) {
    history(command)
    commands[command](target)
  }
}

let activeView = 'north'
function view(newView) {
  if(newView) {
    turn(newView)
    activeView = newView
  }
  return activeView
}

function print() {
  return views[view()] ? views[view()](target) : error('Invalid View')
}

function error(message) {
  return message
}

let past = []
function history(now) {
  if(now) {
    past.push(now)
  }

  return past
}

function map() {
  return {
    key: hello(),
    value: formula(a,b,c),
    history: history(),
    view: view(),
    print: print(),
    score: score(target),
    actions: ['north', 'south', 'waffles'],
    import: {
      meta: {
        url: "${import.meta.url}"
      }
    }
  }
}

function render(tag, x) {
  return "<"+tag+">"+x+"</"+tag+">"
}

map()
view('south')
view('north')
map()
view('waffles')
view('waffles')
view('waffles')
view('waffles')
view('waffles')
view('waffles')
map()
view('waffles')
map()
render('static-code', JSON.stringify(map(), '', 2))
  `,
  output: null
}

const $ = $elf('js-repl', data)
export default $
debugger

window.Module = {
  print: function (msg) { log(msg) }
}
function log(text) {
  $.teach(text, mergeOutput)
}

export async function runJs(program) {
  $.teach({ output: null })
  const QuickJS = await getQuickJS()
  const vm = QuickJS.newContext()

  const result = vm.evalCode(program)
  if (result.error) {
    const error = vm.dump(result.error)
    result.error.dispose()
    vm.dispose()
    return error
  } else {
    const data = vm.dump(result.value)
    result.value.dispose()
    vm.dispose()
    return data
  }
}

async function run() {
  const { input } = $.learn()
  const output = await runJs(input)
  $.teach({ output })
}

$.when('click', '[data-run]', run)
$.when('click', '[data-edit]', () => $.teach({ output: null }))

$.draw(render, { beforeUpdate, afterUpdate })

function render(target) {
  const { input, output } = $.learn()
  return `
    <div class="action-bar">
      <button style="float: right; margin-left: 1rem;" data-run class="standard-button">Run</button>
      <button style="float: right;" data-edit class="standard-button -outlined hide-full">Edit</button>
      <div class="title">Elf Tunnel A</div>
    </div>
    <div class="input ${output?'invisible':'visible'}">
      <textarea
        name="input"
        data-bind="input"
        placeholder="Say it, don't spray it."
        value="${escapeHyperText(input)}"
      ></textarea>
    </div>
    <div class="output ${output?'visible':'invisible'}">
      <div class="textarea">${output}</div>
    </div>
  `
}

function beforeUpdate(target) {
  { // convert a query string to new post
    const q = target.getAttribute('q')
    if(!target.initialized) {
      target.initialized = true
      if(q) {
        const input = decodeURIComponent(q)
        $.teach({ input })
      }
    }
  }


}

function afterUpdate(target) {

}

function mergeOutput(state, payload) {
  return {
    ...state,
    output: [...state.output, payload]
  }
}

function escapeHyperText(text = '') {
  if(!text) return ''
  return text.replace(/[&<>'"]/g, 
    actor => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[actor])
  )
}

$.when('input', '[data-bind]', (event) => {
  $.teach({[event.target.name]: event.target.value })
})

$.style(`
  & {
    display: grid;
    grid-template-rows: auto 1fr;
    grid-template-columns: 1fr;
    height: 100%;
    overflow: hidden;
  }

  & .action-bar {
    background: rgba(0,0,0,1);
    padding: .5rem;
    display: block;
  }

  & .title {
    color: rgba(255,255,255,.85);
    font-weight: bold;
    font-size: 1.5rem;
  }

  & .input textarea {
    border: none;
    height: 100%;
    width: 100%;
    resize: none;
    background: rgba(0,0,0,.85);
    color: rgba(255,255,255,.85);
    padding: .5rem;
    border-radius: 0;
  }

  & .output {
    height: 100%;
    overflow: auto;
    padding: .5rem;
  }

  & .output .textarea {
    white-space: preserve;
  }

  & .invisible {
    display: none;
  }

  @media (min-width: 36rem) {
    & {
      display: grid;
      grid-template-rows: auto 1fr;
      grid-template-columns: 1fr 1fr;
    }

    & .action-bar {
      grid-column: -1 / 1;
    }

    & .invisible {
      display: block;
    }

    & .hide-full {
      display: none;
    }
  }
`)

$elf($)
