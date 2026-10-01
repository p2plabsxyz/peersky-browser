# Backup and Restore

Peersky creates passphrase-encrypted local backups and device-sealed identity
transfers. Both flows are available from `peersky://backup`.

## Local backups

A local backup contains:

```
manifest.json
backup-payload.bin
```

`backup-payload.bin` is an AES-256-GCM encrypted zip. Its key is derived from
the user passphrase with scrypt. The encrypted inner zip can contain:

```
lastOpened.json
tabs.json
bookmarks.json
ensCache.json
ipfsCache.json
hyperCache.json
hyper/
privateHyperdrives.json
hyper-private/
private-drive-key.json
peersky-chat-rooms.json
peersky-ports.json
peersky-identity.json
```

`privateHyperdrives.json`, `hyper-private/`, and `private-drive-key.json`
are included only when private uploads are included (`includePrivate`). The
private corestore is encrypted with the per-profile key carried in
`private-drive-key.json`, so the extracted archive can only be read back
with that key file.

The `hyper/` corestore contains secret keys for writable Hypercores, so every
local backup is encrypted. The `ipfs/` repository is not backed up. It contains
the libp2p private key and a refetchable blockstore; excluding it avoids copying
private key material and large cache data.

The passphrase is not stored by Peersky and cannot be recovered. A passphrase
must contain at least 12 characters.

## Consistent archives

Hyper and IPFS services are suspended during creation. Each file is hashed
while its bytes are streamed into the inner archive. The manifest therefore
describes the bytes that were actually archived rather than an earlier read of
the live file.

Lock and transient database files named `LOCK`, `repo.lock`, `*.lock`, `LOG`,
and `LOG.old` are excluded.

## Restore safety

Peersky extracts and verifies the complete payload before changing live data.
Every target is then copied to a staging directory on the same filesystem. The
live targets are renamed into a rollback directory and staged targets are
renamed into place. If a swap fails, already swapped targets are rolled back.
Old data is removed only after every target has been swapped successfully.

A restart is required after a successful restore so Hyper and IPFS reopen from
a clean process.

## Restoring from the network

Restore from the network takes a `hyper://` link and works in two steps.
The download is read first: a backup waits for the person to say restore, and
an identity transfer is checked, decrypted and verified into
`.peersky-incoming-*` inside the profile folder, then its six character code
is shown. Nothing in the profile changes until the person confirms. Cancelling,
or leaving the page, drops what was fetched, and anything a crash leaves behind
is cleared at the next start.

A transfer fetched this way must have been made for a pairing code this
desktop showed in the last hour (`src/backup/pairing-sessions.js`). A code
answers one transfer; once it is used, the page shows a fresh one.

## Identity transfer

Identity transfer is intended for moving the identity to a specific receiving
device:

1. The receiver displays a `peersky-identity:` device pairing code containing its
   encryption public key, nonce, and device type.
2. Desktop scans or pastes that complete code. The sender cannot choose the
   receiver type in the UI.
3. Desktop creates an identity payload and encrypts a random content key to the
   receiver with a Sodium sealed box. The payload uses AES-256-GCM.
4. Desktop signs the transfer metadata and publishes the sealed zip to a
   temporary Hyperdrive.
5. Both devices show the first six uppercase hexadecimal characters of:

   `sha256(sourceSigningPublicKey || targetEncryptionPublicKey || nonce)`

6. The user compares this code before confirming the restore.

The transfer signature is self-signed because its public key travels in the
same transfer. The matching verification code is the authentication step that
binds the displayed desktop key to the receiver session.

Identity transfers do not have an application-defined size limit on desktop or
mobile. Available memory, storage, and the underlying ZIP format still determine
the largest transfer a device can process.

A phone gets only what it keeps: `tabs.json`, `bookmarks.json`,
`peersky-identity.json`, and, with private uploads included, the private
drives and `private-drive-key.json`. The phone merges the tabs and bookmarks
into its own. It does not get `hyper/`, this desktop's own corestore, which
nothing on the phone opens and which can run to gigabytes. The key goes to a
phone even when there are no private drives yet, because the phone encrypts
its own private uploads with it, and that is what lets this desktop open them.
A phone whose code says it takes PeerChat also gets `peerchat-incoming.json`
(see [PeerChat on several devices](#peerchat-on-several-devices)).

## Receiving from a phone

PeerSky Mobile can send to this desktop. The phone scans the pairing code on
the Backup & Restore page and puts a transfer up for it, in the same format
as an identity transfer: sealed to this desktop, signed by the phone, and
encrypted with AES-256-GCM. The decrypted payload says `"source": "mobile"`
and holds only:

```
phone-tabs.json
phone-bookmarks.json
phone-private-drives.json
phone-peerchat.json
```

Paste or scan the phone's link under Restore from the network. After the code
is confirmed (`src/backup/phone-sync.js`):

- the phone's bookmarks and favourites are added after this desktop's own,
  and one already here is left as it is,
- the phone's tabs open asleep, in a collapsed group called Phone, in the
  window the page is in. A page already open in any window is left out: it is
  often one this desktop sent to the phone, coming back,
- the phone's private drive is added to the private drives as
  `Private files from your phone`, read-only here,
- PeerChat takes the phone's name, bio and picture, with this desktop's
  label after the name, and joins the phone's rooms.

Nothing else is replaced and nothing restarts. The page then says what was added,
or that everything the phone sent was already here. Each entry is read into
memory with a size cap and checked against the manifest, since anyone who can
see this desktop's code could send it something.

The phone sends its private drive with the drive's own key. This desktop keeps
that key in the `entries` of `private-drive-key.json`, beside its own key
(`getPrivateDriveKeyFor` in `src/backup/private-drive-key.js`), and opens the
drive with it. So it does not matter which key the phone made the drive with:
one from before the phone was linked opens here, and so does the drive of a
phone that was linked to another desktop. Backups and transfers carry the
per-drive keys in the same entries, so a desktop or phone this profile goes to
next opens the drive too. A drive's key never changes, so the first one kept
for a drive stays. A drive this desktop made is left alone whatever a phone
lists: it is never renamed, made read-only, or given another key.

The phone's drive lives on the phone, so a file in it is not on this desktop
until it is first read. When a private drive this desktop cannot write does
not have a file, its peers are asked for the latest before the answer is
File not found, for up to 15 seconds, as for a public drive, and at most once
every 30 seconds per drive (`src/protocols/private-hyperdrive.js`).

A desktop still in its first-run screen takes the phone's link there too,
under "Restore a backup, or bring tabs from your phone", which also shows this
desktop's pairing code. Once the codes match, onboarding closes and the first
window opens with the phone's tabs asleep beside Home.

Identity transfer creates an independent copy of the identity, and there is no
cryptographic revocation: removing a phone could not take back keys already
copied to it. What this desktop does keep is a guard against the accidental
second phone (`src/backup/mobile-pairing.js`): an identity goes to one phone
at a time, and "Move to a new phone" releases it.

## PeerChat on several devices

A person's PeerChat goes with their identity. Each device stays its own member
of a room, and everyone sees which device a message came from by a label after
the name: the device the name was made on shows the name alone, the phone
shows `ada@mobile`, and desktops `ada@desktop1`, `ada@desktop2`. When the name
was made on the phone, the first desktop is `ada@desktop`. There is one phone,
and moving to a new phone is "Move to a new phone" on the old one. The label is
fixed: it cannot be edited and does not change with the name.

A device takes PeerChat only when its pairing code says `chat=1`. An older app
refuses files it does not know, so it is sent none. A desktop says so only when
its PeerChat has the transfer functions: installs move the PeerChat submodule to
its newest commit, and `hyper-handler.js` reads those functions through the
module namespace, so a PeerChat without them loads and transfers go without it. A transfer to a newer one
carries `peerchat-incoming.json` (a phone sends `phone-peerchat.json`) with
the profile, every room with its key, the label the other device takes, and a
link: a random secret the person's devices share. Room keys travel in the
clear inside the sealed transfer, because the copy in the chat file is locked
to the sending desktop's keychain.

A name, bio or picture changed on one device reaches the others the next time
they share a room. Each profile a device sends carries a proof made with the
link, and a device takes a newer profile only with a proof it can check, so
nobody else can rename a person's devices. A room joined later on one device
is not sent to the others; a new transfer or the room's link brings it.

A desktop restored from another desktop starts with a copy of its stores, and
the keys its network connections are made with come from those stores. Two
desktops on one key are one peer: they push each other off the network, and in
PeerChat they are one member. So a desktop restored from a transfer makes keys
of its own once (`peersky-network-keys.json`, `src/backup/network-keys.js`),
which no backup or transfer carries. A room the other desktop made stays that
desktop's to run, and PeerChat keeps its room feeds under the new key, starting
from the copy: two desktops appending to one feed would fork it, and a forked
feed is frozen for good. A backup restored on the same desktop keeps its keys.

The temporary Hyper publisher uses storage outside the normal `hyper/`
corestore and is closed and deleted when the transfer expires. Transfer drives
therefore do not accumulate in later backups.

## P2P publishing

The general "Share via P2P" action is not available. `uploadBackup` requires a
valid encrypted wrapper, rejects unexpected files, and verifies the encrypted
payload checksum before publishing. The remaining UI upload path is the
device-sealed identity transfer described above.

## Implementation

- `src/backup/backup-core.js`: archive streaming, checksums, extraction, and
  zip path validation.
- `src/backup/encrypted-backup.js`: passphrase-encrypted local backup wrapper.
- `src/backup/identity-transfer.js`: receiver-sealed identity transfer and
  verification code derivation.
- `src/backup/phone-sync.js`: reading and adding what a phone sends.
- `src/backup/network-keys.js`: the network keys of a desktop restored from
  another desktop.
- `src/backup/pairing-sessions.js`: the pairing codes this desktop has shown.
- `src/backup/backup-manager.js`: service suspension, transactional restore,
  and the two-step restore from the network.
- `src/backup/p2p-backup.js`: encrypted-wrapper upload gate and P2P download.
- `src/backup/ipc.js`: backup page IPC handlers.
- `src/backup/ipc-caller.js`: refuses a backup or onboarding channel called
  from any page but Backup & Restore or onboarding, as `bt-api-token` does.
