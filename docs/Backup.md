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
  ipfsCache.json           # IPFS address cache
  hyperCache.json          # Hypercore address cache
  ipfs/                    # full IPFS (Helia) repository
  hyper/                   # full Hypercore storage
```

*Note: Identity-sensitive files (chat rooms, ports, device registry) are explicitly EXCLUDED from standard backups. They are only included when performing an "Identity Transfer".*

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

## Secure identity transfer

The current backup flow is broad: a user can restore any valid
backup file or P2P address as many times as they want. Identity transfer is
a separate flow because `peersky-ports.json`, PeerChat keys, and
Hyper/IPFS repositories carry long-lived private identity material.

The implemented flow is:

1. The importing device (e.g., a mobile phone) locates its persistent device keypair and displays its public encryption key as a QR code (e.g., on PeerSky Mobile's "Link Device" screen).
2. The exporting device (Desktop) uses the **Scan QR** button to activate the local webcam via `jsQR` and scans the importing device's public key (or the user manually enters it).
3. The exporting device reads the signed `peersky-devices.json` registry. Mobile slots can be safely overwritten.
4. The exporting device creates an identity-only backup payload, encrypts it securely to the importing device's public encryption key using Sodium sealed boxes, signs the transfer metadata, and uploads it to `hyper://`.
5. A QR code containing the resulting `hyper://` URL is displayed on the exporting device (Desktop).
6. The importing device (Mobile) scans the Desktop's `hyper://` QR code using its camera, downloads the payload, verifies the signature, decrypts the payload with its private key, imports atomically, and restarts.
7. The importing device assumes ownership of the identity registry (to manage future pairs) and clears its device slot upon restore.

Useful implementation units:

- `src/backup/device-keys.js` - persistent Ed25519 signing key and X25519/box
  encryption key for this install.
- `src/backup/device-registry.js` - signed `peersky-devices.json` with
  `desktop` and `mobile` slots.
- `src/backup/identity-transfer.js` - encrypted payload creation and limit enforcement.
- `src/backup/ipc.js` - IPC handlers for creating the encrypted zip, uploading, and fetching.
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
