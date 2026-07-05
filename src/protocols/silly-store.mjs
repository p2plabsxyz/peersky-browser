// silly-store.mjs — vendored verbatim from plan1's storage.mjs (the real
// state engine behind plan1's production geckos relay, multiplayer.js).
// Reused unmodified here so the silly:// relay's merge semantics match
// plan1's actual production behavior exactly, rather than reimplementing it.

export default function createStore(initialState = {}, broadcast = () => null, secureEval) {
  let state = {
    ...initialState
  };

  return {
    set: function(elf, knowledge, nuance) {
      let mergeStr;

      if (typeof nuance === 'function') {
        mergeStr = nuance.toString();
      } else if (typeof nuance === 'string') {
        mergeStr = nuance;
      } else {
        console.error('Invalid nuance type:', typeof nuance);
        return;
      }

      const wisdom = secureEval(`
        const localState = JSON.parse(stateStr);
        const knowledge = JSON.parse(knowledgeStr);

        const merge = (${mergeStr});

        const output = merge(localState || {}, knowledge);

        JSON.stringify(output);
      `, {
        stateStr: JSON.stringify(state[elf] || {}),
        knowledgeStr: JSON.stringify(knowledge)
      });

      if (wisdom.error) {
        console.error(`Sandboxed execution failed: ${wisdom.error}`);
      } else {
        state = {
          ...state,
          [elf]: JSON.parse(wisdom.data)
        };

        broadcast(elf);
      }
    },

    get: function(elf) {
      return state[elf];
    }
  }
}
