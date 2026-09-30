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
```

Paste or scan the phone's link under Restore from the network. After the code
is confirmed (`src/backup/phone-sync.js`):

- the phone's bookmarks and favourites are added after this desktop's own,
  and one already here is left as it is,
- the phone's tabs open asleep, in a collapsed group called Phone, in the
  window the page is in,
- the phone's private drive, encrypted with this desktop's key, is added to
  the private drives as `Private files from your phone`, read-only here.

Nothing is replaced and nothing restarts. Each entry is read into memory with
a size cap and checked against the manifest, since anyone who can see this
desktop's code could send it something.

Identity transfer creates an independent copy of the identity, and there is no
cryptographic revocation: removing a phone could not take back keys already
copied to it. What this desktop does keep is a guard against the accidental
second phone (`src/backup/mobile-pairing.js`): an identity goes to one phone
at a time, and "Move to a new phone" releases it.

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
- `src/backup/pairing-sessions.js`: the pairing codes this desktop has shown.
- `src/backup/backup-manager.js`: service suspension, transactional restore,
  and the two-step restore from the network.
- `src/backup/p2p-backup.js`: encrypted-wrapper upload gate and P2P download.
- `src/backup/ipc.js`: backup page IPC handlers.
