# P2PMD load test

Puts one P2PMD note under load on this machine: the desktop's own P2PMD host
serving many simulated editors, some of them typing, and prints what that cost.

```bash
npm run test:load:p2pmd
npm run test:load:p2pmd -- --people 20 --typing 3 --seconds 20
npm run test:load:p2pmd -- --lan
```

It is not part of `npm test`: `test/run-tests.mjs` leaves out `test:load:*`
scripts.

## Options

| Option | Default | |
|---|---|---|
| `--people` | 100 | editors in the note |
| `--typing` | 10 | how many of them type |
| `--seconds` | 60 | how long they type |
| `--editor` | `desktop` | which P2PMD editor they act like: `desktop` or `phone` |
| `--lan` | off | each editor a device of its own, reaching the note through a tunnel on the local network, as with no internet |
| `--join-every` | 20 | one person joins every this many milliseconds, so 100 take two seconds |
| `--out` | | also write the results to a JSON file |

## What it runs

- **The host:** the real `src/protocols/hs-handler.js` under plain Node, the
  way `test/p2p/hs-handler.test.js` runs it. `hooks.mjs` is registered with
  `module.register` and swaps `electron` for `electron-stub.mjs`, whose
  `app.getPath` is the run's temp folder, and `holesail` for
  `holesail-stub.mjs`, which makes a room key from a made-up seed. The host
  makes the note with `hs://p2pmd?action=create`, as the P2PMD page does, and
  its server binds `127.0.0.1`. It has a process of its own, so its CPU and memory are
  its own.
- **The note:** about 60 lines of team notes that three people wrote earlier,
  posted to `/doc` with each line's author, and a line for each typist.
- **The editors:** 25 to a process. Each makes the requests its editor makes to
  open a note, opens `/events`, and keeps its own Yjs copy of the note from
  the host's `yjsupdate` events. One whose join fails presses Join again a
  second later, up to three times, and the results say how many had to.
- **The typists:** each types on its own line, a character every 100 ms, and
  sends the Yjs change to `/doc/update`. Every tenth edit is a token, timed
  until every other editor has it.

- **With `--lan`:** `hooks.mjs` gives `hs-handler.js` a local network
  instance from `lan.mjs` in place of Hyper's, so `hs-handler.js` itself puts
  the note on the local network, as it does with no internet. Each editor is
  a device of its own, with its own instance (`@p2plabs/hyperdht-mdns`, found
  over real mDNS) that is up before anyone joins, and joins as `hs-handler.js`
  does with no internet (`findNoteOnLan`, `reachNoteOnLan`, `askNotePortOnLan`
  and `openNoteOnLan` from `p2pmd-lan.js`), so its requests go through an
  encrypted tunnel of its own. `lan.mjs` is the checkout's own, as `host.mjs`
  is.

`--editor` picks the editor:

- `desktop`: the editor in the p2pmd repo (`p2p.js`), which this app uses. With
  each edit it sends the authors of its own lines, and it sends presence to
  `/presence`, here every 220 ms.
- `phone`: the editor page in PeerSky Mobile's `backend/p2pmd/server.mjs`, for
  a phone in a note this computer hosts. With each edit it sends every line
  author it knows of. It sends no presence while typing, and applies what the
  host sends every 80 ms.

Both editors wait for a 100 ms pause before sending an edit, and the desktop
one for a 220 ms pause before sending presence, so someone typing without a
pause sends little presence. The typists here send both on a steady beat,
which is more.

## What it prints

| Row | What it is |
|---|---|
| People connected | how many the host counts in `/status` |
| Joins that needed another try | shown only when some did |
| Edits sent | `/doc/update` requests while typing, and how many the host refused |
| Every editor ended with the host's text | each editor's copy against `/doc`, once typing stops |
| Time until every editor saw an edit | from a typist sending a token until the last other editor had it |
| Data in per editor | every event from `/events` and every reply to its own requests |
| Out from the host | everything the host wrote on every connection, headers too |
| Host CPU and memory | the host process's CPU time and RSS while people type |
| Note on the host | the note's text and its Yjs state, from `/doc` and `/doc/yjsstate` |

Then the data in per editor by kind of event, and a line for anything to look
at: the host's CPU growing while people typed, the host or the editor
processes running late, or streams dropping. 1 KB is 1000 bytes. With
`--out` the JSON file also has the host's load second by second, the joining,
and how long the typists' requests took. The run exits with 1 when an editor
ended with other text, an edit never reached everyone, the host left edits
unanswered, or a stream dropped.

## What it never does

- Without `--lan`, everything binds to and connects to `127.0.0.1`.
  Holesail, Hyperswarm and the DHT are never started: `holesail` is the stub,
  and `hooks.mjs` refuses to load `hyperswarm` and `hyper-sdk`. It loads
  `hyperdht`, which `p2pmd-lan.js` works out a note's keys with.
- With `--lan`, the devices find each other over mDNS on this machine's
  network, and their tunnels run over UDP on it. Nothing goes to the
  internet: Holesail is still the stub, and `hyper-sdk` is still refused.
- The host saves its room's port in the temp folder, which is removed at the
  end. The PeerSky data folder is never read or written, and no running
  PeerSky is touched.

## What it cannot tell

- What the host does inside the app: here it runs alone under plain Node, not
  in Electron's main process next to the tabs, IPFS and Hyper.
- What a real network adds: delay, bandwidth, dropped connections. With
  `--lan` the tunnels' encryption is in the host's CPU, but every device is
  on this one machine.
- What the editors spend drawing the note, the line gutter and the preview.
- People joining, leaving or reconnecting while others type, and typists
  adding lines, which moves the line numbers of everyone below.

PeerSky Mobile has the same `run.mjs` and `editors.mjs` in `test/load/p2pmd`,
with its own host.

## Last run

On 2026-10-12, on a MacBook Air (Apple M5, 10 cores, 32 GB, Node 24.21), at
the defaults, each typist typing a character every 100 ms on a line of their
own, with this test and PeerSky Mobile's:

| 100 people, 10 typing for 60 s | Phone host, desktop editors | Phone host, phone editors | Desktop host, desktop editors | Desktop host, phone editors |
|---|---|---|---|---|
| Edits sent, none refused | 5,977 (100 a second) | 5,971 (100 a second) | 5,950 (99 a second) | 5,942 (99 a second) |
| Every editor ended with the host's text | yes | yes | yes | yes |
| Time until every editor saw an edit (median, slowest) | 3 ms, 7.1 ms | 66.3 ms, 89.1 ms | 2.5 ms, 5.4 ms | 59.7 ms, 85.4 ms |
| Data in per editor | 44 KB/s | 44 KB/s | 33 KB/s | 32 KB/s |
| Out from the host | 4.5 MB/s | 4.4 MB/s | 3.4 MB/s | 3.3 MB/s |
| Host CPU, first and last 5 s | 14%, 10% | 13%, 10% | 13%, 10% | 12%, 8% |
| Host memory at most | 173 MB | 173 MB | 139 MB | 137 MB |
| Yjs state at the start and end | 8.6 KB, 73.2 KB | 8.6 KB, 116.9 KB | 2.4 KB, 12.1 KB | 2.4 KB, 12.1 KB |

The phone editor applies what the host sends every 80 ms, which sets its
times. The phone host's numbers are from PeerSky Mobile 0.1.3, where an edit
costs the same however long the note has been edited.
