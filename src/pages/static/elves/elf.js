/*
 * Additional Context:
 *
 * The "Self" function returns all the synonyms for the cognitive mappings from other mental systems
 *
 * Use the "addAgent" function to get updates whenever any component in the system is updated, ready for backup
 *
 * There is commented out code in this file that primarily relates to backing up data to personal storage
 *
 */

const { innerHTML } = self.diff || { 
  innerHTML: (target, html) => { 
    target.innerHTML = html 
  } 
}

if(!self.crypto.randomUUID) {
  self.crypto.randomUUID = () => {
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
      (+c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> +c / 4).toString(16)
    );
  }
}

const renderers = {}
const eventMaze = {}
const reactiveFunctions = {}

function addRenderer(link, compositor, lifeCycle) {
  if(!reactiveFunctions[link]) {
    reactiveFunctions[link] = {}
  }

  renderers[link] = {
    compositor,
    lifeCycle
  }

  teach(link, { '_initialized': true })
}

const logs = {}

export function insights() {
  return logs
}

function insight(name, link) {
  if(!logs[`${name}:${link}`]) {
    logs[`${name}:${link}`] = 0
  }
  logs[`${name}:${link}`] += 1
}


function react(link) {
  if(!reactiveFunctions[link]) return

  Object.keys(reactiveFunctions[link])
    .map(id => reactiveFunctions[link][id]())
}

const backupAgents = {}

function ensureAgentDispatcher(link) {
  if(!backupAgents[link]) {
    backupAgents[link] = []
  }
}

function addAgent(link, agent) {
  ensureAgentDispatcher(link)
  backupAgents[link].push(agent)
}

function backup(link) {
  ensureAgentDispatcher(link)

  const allAgents = backupAgents[link]

  allAgents.map(callback => callback())
}

function plan68path(target) {
  return PLAN68_ROOT_DIR + target.id
}

const notifications = {
  [react.toString()]: react,
  [backup.toString()]: backup,
}

function notify(link) {
  Object.keys(notifications)
    .map(key => notifications[key](link))
}

const store = createStore({}, notify)

function update(link, target) {
  if(!renderers[link]) return

  insight('elf:update', link)

  const { lifeCycle, compositor } = renderers[link]
  if(lifeCycle.beforeUpdate) {
    lifeCycle.beforeUpdate.call(this, target)
  }

  const html = compositor.call(this, target)
  if(html) innerHTML(target, html)

  if(lifeCycle.afterUpdate) {
    lifeCycle.afterUpdate.call(this, target)
  }
}

const middleware = [
  c2sSync
]

async function c2sSync(link, target) {
  if(target.getAttribute('offline') === 'true') return
  if(target['c2sSync']) return
  target['c2sSync'] = true

  /*
   *
   * for the future
   *
  downTheData(link, target)
  await guaranteeTheData(link, target)
  upTheData(link, target)

  */
}

function draw(link, compositor, lifeCycle={}) {
  insight('elf:draw', link)
  addRenderer(link, compositor, lifeCycle)
}


function style(link, stylesheet) {
  insight('elf:style', link)
  const styles = `
    <style type="text/css" data-link="${link}">
      ${stylesheet.replaceAll('&', link)}
    </style>
  `;


  document.body.insertAdjacentHTML("beforeend", styles)
}

export function learn(link) {
  insight('elf:learn', link)
  return store.get(link) || {}
}

export function teach(link, knowledge, nuance = (s, p) => ({...s,...p})) {
  insight('elf:teach', link)
  store.set(link, knowledge, nuance)
}

export function when(link, type, arg2, callback) {
  if(typeof arg2 === 'function') {
    insight('elf:when:'+type, link)
    return listen.call(this, link, type, '', arg2)
  } else {
    const nested = `${link} ${arg2}`
    insight('elf:when:'+type, nested)
    return listen.call(this, link, type, arg2, callback)
  }
}

function declare(elf) {
  if (!customElements.get(elf.link)) {
    class WebComponent extends HTMLElement {
      constructor() {
        super();
      }

      connectedCallback() {
        console.log(elf.link, 'declared')
        if (!this._initialized) {
          console.log(elf.link, 'initialized')
          dispatchCreate(elf.link, this)
          console.log(elf.link, 'created')
          this._initialized = true;
        }
      }
    }

    customElements.define(elf.link, WebComponent);
  }
}

export default function Self(link, initialState = {}) {
  if(typeof link !== 'string') {
    declare(link)
    return
  }

  insight('elf', link)
  teach(link, initialState)

  return {
    // for the classical progammers
    model: learn.bind(this, link),
    view: draw.bind(this, link),
    controller: teach.bind(this, link),

    // link is a human that is permitted to be an elf per order of the deku tree
    link: link,
    elf: link,
    table: link,
    root: link,
    tag: link,
    selector: link,
    body: link,

    // link has an ear to listen to the peoples of zora, goron, korok, kokiri, rito, gerudo, hyrule, et al
    ear: learn.bind(this, link),
    learn: learn.bind(this, link),
    get: learn.bind(this, link),
    read: learn.bind(this, link),
    object: learn.bind(this, link),
    subject: learn.bind(this, link),
    predicate: learn.bind(this, link),

    // link has a head to keep all his facts straight in the current moment in time
    head: draw.bind(this, link),
    draw: draw.bind(this, link),
    render: draw.bind(this, link),

    // link has an eye through which to spy reality
    eye: style.bind(this, link),
    style: style.bind(this, link),
    flair: style.bind(this, link),
    skin: style.bind(this, link),
    fashion: style.bind(this, link),

    // link has a hand to move the pieces into place at his command
    hand: when.bind(this, link),
    when: when.bind(this, link),
    on: when.bind(this, link),
    listen: when.bind(this, link),

    // link has a mouth that he lets others stuff with their hopes and dreams
    mouth: teach.bind(this, link),
    teach: teach.bind(this, link),
    set: teach.bind(this, link),
    write: teach.bind(this, link),
    put: teach.bind(this, link),
    post: teach.bind(this, link),
    patch: teach.bind(this, link),
    delete: teach.bind(this, link),
  }
}

export function subscribe(fun) {
  notifications[fun.toString] = fun
}

export function unsubscribe(fun) {
  if(notifications[fun.toString]) {
    delete notifications[fun.toString]
  }
}

export function listen(link, type, scope, handler = () => null) {
  const callback = (event) => {
    if(
      event.target &&
      event.target.matches &&
      event.target.matches(scope)
    ) {

      insight('elf:listen:'+type, link)
      handler.call(this, event);
    }
  };

  const options = { capture: true, passive: false }

  addToEventMaze(link, { type, callback, options })

  function addToEventMaze(link, eventMetadata) {
    if(!eventMaze[link]) {
      eventMaze[link] = []
    }

    eventMaze[link].push(eventMetadata)
  }

  return function unlisten(target) {
    target.removeEventListener(type, callback, options);
  }
}

function dispatchCreate(link, target) {
  insight('elf:create', target.localName)
  try {
    if(!target.id) target.id = self.crypto.randomUUID()
  } catch(e) {
    if(!target.id) target.id = uuidv4()
  }
  middleware.forEach(x => x(link, target))
  const draw = update.bind(this, link, target)
  reactiveFunctions[link][target.id] = draw

  console.log(link, 'reactive')
  draw()
  console.log(link, 'drawn')

  if(eventMaze[link]) {
    console.log(link, 'event horizoned')
    eventMaze[link].forEach(({ type, callback, options }) => {
      target.addEventListener(type, callback, options);
    })
  }
}

function createStore(initialState = {}, subscribe = () => null) {
  let state = {
    ...initialState
  };

  return {
    set: function(link, knowledge, nuance) {
      const wisdom = nuance(state[link] || {}, knowledge);

      state = {
        ...state,
        [link]: wisdom
      };

      subscribe(link);
    },

    get: function(link) {
      return state[link];
    }
  }
}

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
