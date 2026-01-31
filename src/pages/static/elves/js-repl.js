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
const string = 'string'
const bool = 'boolean'
const number = 'number'

const logs = []
const bugs = []

const Types = {
  string,
  bool,
  number,
  True,
  False,
  Value,
  Integer,
  Float,
  Horizon,
  Text,
  Add,
  Subtract,
  Multiply,
  Divide,
  Modulo,
  Box,
  Expect,
  Describe,
  Log,
  Bug,
  Dashboard
}

function True() {
  return true
}

function False() {
  return false
}

function Value(x) {
  return x
}

function Integer(x) {
  return parseFloat(x)
}

function Float(x) {
  return parseFloat(x)
}

function Horizon(x) {
  return new Date(x)
}

function Text(x='') {
  return x.toString()
}

function Add(a, b) {
  return a + b
}

function Subtract(a, b) {
  return a - b
}

function Multiply(a, b) {
  return a * b
}

function Divide(a, b) {
  return a / b
}

function Modulo(a, b) {
  return a % b
}

function Box(x) {
  return { ...x }
}

function Expect(a, b) {
  if(a === b) {
    return Success()
  } else {
    Bug(a, b)
    return Failure()
  }
}

async function Describe(x, a) {
  try {
    Log(x, await a(Success))
  } catch (error) {
    Bug(x, error.message)
    Failure()
  }
}

function Success() {
  return True()
}

function Failure() {
  throw new Error('Game Over')
}

function Log(...args) {
  console.log.apply(null, args)
  logs.push(args.join(' '))
}

function Bug(...args) {
  console.error.apply(null, args)
  bugs.push(args.join(' '))
}

function Dashboard() {
  return { logs, bugs }
}

JSON.stringify({
  test1: Expect(True(), Success()),
  test2: Expect(Add(3,1), 4),
  test3: Expect(Subtract(3,1), 2),
  test4: Expect(Subtract(1,3), -2),
  test5: Expect(Multiply(9,9), 81),
  test6: Expect(Divide(9,9), 1),
  test7: Expect(Modulo(9,9), 0),

}, null, 2)
  `,
  output: null
}

const $ = $elf('js-repl', data)
export default $

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
      >${escapeHyperText(input)}</textarea>
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
