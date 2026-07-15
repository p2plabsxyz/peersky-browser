# Backup & Restore

Peersky can bundle its persistent application data into a single portable `.zip`
file and restore it later, on the same machine or a different one. The feature
lives at `peersky://backup` (linked from the Settings sidebar).

## What is included

The backup bundle contains the following top-level entries from the app's
`userData` directory. JSON files are skipped when absent.

```
peersky-backup-{timestamp}.zip
  manifest.json            # format version, Peersky version, createdAt, per-entry checksums
  lastOpened.json          # window geometry / last session
  tabs.json                # open tabs across windows
  ensCache.json            # ENS resolution cache
  peersky-chat-rooms.json  # PeerChat rooms, keys, profiles
  peersky-ports.json       # P2P app (Holesail) identity seeds
  ipfs/                    # full IPFS (Helia) repository
  hyper/                   # full Hypercore storage
```

Live database lock and in-flight files (`LOCK`, `repo.lock`, `*.lock`) are
excluded from the bundle.

## manifest.json

```json
{
  "version": "1.0.0",
  "peerskyVersion": "1.0.0-beta.26",
  "createdAt": "2026-06-07T12:00:00.000Z",
  "files": {
    "tabs.json": "sha256:...",
    "ipfs": "sha256:...",
    "hyper": "sha256:..."
  }
}
```

Each file entry is a sha256 of the file; each directory entry is a sha256 over
its files (sorted by relative path). On restore the extracted contents are
verified against these checksums before any live data is touched.

## Creating a backup

1. Open `peersky://backup` and click **Create Backup**.
2. Choose where to save the `.zip` (defaults to the Downloads folder).
3. The bundle is written by a background worker thread so the UI stays
   responsive; a progress bar shows compression progress.

## Restoring a backup

1. Open `peersky://backup` and click **Choose Backup File**.
2. The selected bundle's manifest is shown (creation date, Peersky version,
   contents). Click **Restore** and confirm.
3. The bundle is extracted to a temporary directory and verified against its
   manifest. Existing `ipfs/` and `hyper/` directories are removed first so old
   and new repositories never mix, then the backup contents overwrite the
   matching entries in `userData`.
4. A restart is required. Confirm the prompt to relaunch Peersky and load the
   restored data.

## Planned secure identity transfer

The current backup flow is intentionally broad: a user can restore any valid
backup file or P2P address as many times as they want. Identity transfer should
be a separate pairing flow because `peersky-ports.json`, PeerChat keys, and
Hyper/IPFS repositories can carry long-lived private identity material.

The planned flow is:

1. The importing device creates or loads a persistent device keypair and starts
   a short-lived pairing session.
2. Peersky renders the pairing session as a QR code for mobile scan, and as a
   compact manual string for desktop/mobile fallback.
3. The exporting device reads that QR/string, checks the signed
   `peersky-devices.json` registry, and refuses identity export if that identity
   already has a paired device of the requested type.
4. The devices connect over a temporary Hyper/Hyperswarm rendezvous topic.
5. Both devices derive a short verification code from the pairing transcript
   and public keys. The user confirms that code before transfer.
6. The exporting device creates an identity-only backup payload, encrypts it to
   the importing device's public encryption key, signs the transfer metadata,
   and uploads it to `hyper://`.
7. The importing device downloads from `hyper://`, verifies the signature and
   transcript, decrypts with its private key, imports atomically, and restarts.
8. On success, the exporting device records the importing device public key in
   `peersky-devices.json`.

The device limit is cooperative, not a hard DRM mechanism. If a user can copy
raw `userData` files or an unencrypted backup zip manually, software cannot
cryptographically prevent them from duplicating the identity. The enforceable
product rule is: Peersky's identity-transfer UI should only allow one imported
desktop and one imported mobile per identity, unless the user revokes a paired
device first.

Useful implementation units:

- `src/backup/device-keys.js` - persistent Ed25519 signing key and X25519/box
  encryption key for this install.
- `src/backup/device-registry.js` - signed `peersky-devices.json` with
  `desktop` and `mobile` slots.
- `src/backup/identity-transfer.js` - QR/manual string parsing, verification
  code derivation, encrypted payload creation, and Hyper upload/download.
- `src/backup/ipc.js` - IPC handlers for starting pairing, accepting a
  pairing code, approving transfer, importing payload, and revoking devices.
- `src/pages/backup.html` and `src/pages/static/js/backup.js` - a separate
  "Identity transfer" section, distinct from regular backup/restore.

## Implementation notes

- `src/backup/backup-core.js` - pure zip/extract/manifest logic (`archiver` for
  writing, `unzipper` for reading), with zip-slip path-traversal protection.
- `src/backup/backup-worker.js` - `worker_threads` entry that runs create and
  extract off the main process event loop.
- `src/backup/backup-manager.js` - orchestrates the worker, verifies manifests,
  performs the restore overwrite, and triggers the relaunch.
- `src/backup/ipc.js` - `setupBackupIpc()` registers the `backup-create`,
  `backup-validate`, `backup-restore`, and `backup-relaunch` IPC handlers and
  forwards `backup-progress` events to the renderer.

### Live-snapshot limitation

Backups are created while the app is running. The IPFS (LevelDB) and Hypercore
repositories are streamed live (best-effort snapshot), matching how the existing
"Reset P2P Data" action manipulates these directories in place. Lock files are
skipped, but a backup taken during heavy P2P write activity may capture a
slightly inconsistent repository. For the most consistent backup, avoid active
uploads/downloads while creating one. Restored repositories always re-open from
a clean process because a restart is enforced.
