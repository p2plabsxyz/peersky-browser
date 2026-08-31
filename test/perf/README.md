# Performance regression tests

These measure the *work* the browser does on its hot paths — renderer
round-trips, disk stats, node boots, state writes — rather than wall-clock
times, which vary too much across machines and CI runners to assert on.

Each test pins one property that a past change made slow, so re-introducing the
slow shape fails the build:

| File | Guards |
| --- | --- |
| `lazy-p2p-startup.test.js` | The p2p backends do not boot before the first window can paint. |
| `extension-startup.test.js` | Extensions load together, and a tab that attaches mid-boot is not lost. |
| `session-save-coalescing.test.js` | A burst of window/tab events writes the session once, not once per event. |
| `static-asset-cache.test.js` | Internal assets resolve once and revalidate instead of being re-read. |
| `browser-action-latency.test.js` | Opening an extension popup costs no renderer round-trip and no directory scan. |

Run with `npm run test:perf`.
