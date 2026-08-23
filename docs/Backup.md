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
ensCache.json
ipfsCache.json
hyperCache.json
hyper/
peersky-chat-rooms.json
peersky-ports.json
peersky-identity.json
```

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

Identity transfer creates an independent copy of the identity. There is no
claimed one-mobile limit or cryptographic revocation mechanism. Removing a
device from a local registry could not revoke keys already copied to that
device, so the old registry and slot enforcement have been removed.

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
- `src/backup/backup-manager.js`: service suspension and transactional restore.
- `src/backup/p2p-backup.js`: encrypted-wrapper upload gate and P2P download.
- `src/backup/ipc.js`: backup page IPC handlers.
