/**
 * Trailing-edge coalescing for work that is requested far more often than it
 * needs to run.
 *
 * Window moves, resizes, navigations and tab edits all ask for the same session
 * snapshot, and a drag asks for it hundreds of times a second. Running each
 * request means a renderer round-trip per window plus two JSON writes, which is
 * exactly the work that makes dragging a window stutter. Coalescing collapses a
 * burst into one run without ever dropping the last request: whatever state the
 * burst ended in is what gets saved.
 *
 * Free of Electron imports so the timing rules can be tested directly.
 */

/**
 * @typedef {object} CoalescedTask
 * @property {() => void} schedule - Ask for a run; collapses into any pending one.
 * @property {() => Promise<any>} flush - Run now if anything is pending, and wait for it.
 * @property {() => void} cancel - Drop a pending run without executing it.
 * @property {() => boolean} isPending
 */

/**
 * @param {object} options
 * @param {() => any} options.run - The work to coalesce. May be async.
 * @param {number} options.waitMs - Quiet period before a run fires.
 * @param {number} [options.maxWaitMs] - Upper bound on how long a continuous
 *   burst may defer the run. Without it, a drag that never pauses would never
 *   save. Defaults to four times waitMs.
 * @param {(error: Error) => void} [options.onError]
 * @returns {CoalescedTask}
 */
export function createCoalescedTask ({ run, waitMs, maxWaitMs, onError }) {
  if (typeof run !== 'function') throw new TypeError('run must be a function')
  if (!(waitMs >= 0)) throw new TypeError('waitMs must be a non-negative number')

  const maxWait = maxWaitMs ?? waitMs * 4
  let timer = null
  /** Deadline for the current burst, so a continuous burst still runs. */
  let deadline = 0
  let inFlight = null

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
    deadline = 0
  }

  const fire = () => {
    clear()
    try {
      const result = run()
      inFlight = Promise.resolve(result).catch((error) => {
        onError?.(error)
      })
      return inFlight
    } catch (error) {
      onError?.(error)
      return Promise.resolve()
    }
  }

  const arm = (delay) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(fire, delay)
    // A pending save must never be the reason the process stays alive.
    timer.unref?.()
  }

  return {
    schedule () {
      const now = Date.now()
      if (!timer) {
        deadline = now + maxWait
        arm(waitMs)
        return
      }
      // Re-arm for another quiet period, but never past the burst deadline.
      arm(Math.max(0, Math.min(waitMs, deadline - now)))
    },

    async flush () {
      if (timer) return fire()
      return inFlight ?? Promise.resolve()
    },

    cancel () {
      clear()
    },

    isPending () {
      return timer !== null
    }
  }
}
