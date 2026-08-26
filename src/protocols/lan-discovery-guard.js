/**
 * Keeping LAN discovery failures out of the hyper:// request path.
 *
 * @p2plabs/hyperdht-mdns advertises every joined topic in a single mDNS TXT
 * record and throws a RangeError once that record no longer fits (900 bytes,
 * which a 43-character token per topic exhausts at the 19th topic — well below
 * its own MAX_ADVERTISED_TOPICS of 32).
 *
 * That throw is not contained: hyper-sdk's patched join() tears down the
 * public-DHT session it just created and rethrows, so the error surfaces out of
 * getDrive() and fails the whole page load:
 *
 *   RangeError: LAN mDNS TXT record exceeds 900 bytes; reduce joined topics
 *       at HyperDHTmDNS.join → SDK.joinCore → SDK.getDrive → protocolHandler
 *
 * In practice that means hyper:// stops working entirely once a session has
 * opened about nineteen drives.
 *
 * LAN discovery is an optimisation for finding peers on the same network; the
 * public DHT is what actually has to work. So when the advertisement is full,
 * skip it for that topic and let the join proceed globally. The skipped topic
 * stays un-advertised for the life of its session — it is not retried when a
 * slot frees up — which costs local-network discovery for that one drive and
 * nothing else.
 *
 * Kept free of Electron imports so the rules can be tested directly.
 */

/** Resolves like a Hyperswarm PeerDiscovery that found nothing. */
function noopDiscovery () {
  return {
    // `false` marks "nothing refreshed here"; the global session still counts.
    refresh: async () => false,
    flushed: async () => {},
    destroy: async () => {}
  }
}

/**
 * Wrap a HyperDHTmDNS instance so a full advertisement degrades to a
 * public-DHT-only join instead of failing the request.
 *
 * Patches the instance's own public join(), which is what hyper-sdk's wrapper
 * calls; any error that is not the LAN capacity limit still propagates.
 *
 * @param {{ join: Function }} lan - Instance returned by attachHyperSDK.
 * @param {object} [options]
 * @param {(message: string) => void} [options.onSkip] - Called once per topic
 *   that could not be advertised.
 * @returns {typeof lan} The same instance, for chaining.
 */
export function guardLANTopicLimit (lan, { onSkip } = {}) {
  if (!lan || typeof lan.join !== 'function') return lan
  if (lan.__peerskyTopicLimitGuarded) return lan
  lan.__peerskyTopicLimitGuarded = true

  const join = lan.join.bind(lan)

  lan.join = (topic, opts) => {
    try {
      return join(topic, opts)
    } catch (error) {
      if (!isTopicCapacityError(error)) throw error
      onSkip?.(`Advertisement full, joining this topic over the public DHT only: ${error.message}`)
      return noopDiscovery()
    }
  }

  return lan
}

/**
 * True for the two ways hyperdht-mdns reports "no room for another topic":
 * the record no longer fits, or the hard topic cap was reached.
 *
 * Matched on type plus message because the module exports no error code.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTopicCapacityError (error) {
  if (!(error instanceof RangeError)) return false
  const message = String(error.message || '')
  return /TXT record exceeds/i.test(message) || /more than \d+ (LAN )?topics/i.test(message)
}
