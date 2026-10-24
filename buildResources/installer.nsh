; "Open with P2PMD" on the right-click menu of text files, with the P2PMD
; logo, for the person who installs Peersky (the installer is per user). It
; runs Peersky with --open-in-p2pmd and the file, which becomes a new private
; P2PMD note (src/open-in-p2pmd.js). Only a menu item is added: Peersky never
; becomes the app that opens these files on a double click.
;
; SystemFileAssociations\text covers every file Windows sees as text. .md and
; .markdown have no such type on a new Windows, and .txt can lose it when
; another app registers .txt for the user, so they are named too.

!macro peerskyAddP2pmdItem KEY
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${KEY}\shell\PeerskyP2PMD" "" "Open with P2PMD"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${KEY}\shell\PeerskyP2PMD" "Icon" "$INSTDIR\resources\p2pmd.ico"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${KEY}\shell\PeerskyP2PMD\command" "" '"$appExe" --open-in-p2pmd "%1"'
!macroend

!macro peerskyRemoveP2pmdItem KEY
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\${KEY}\shell\PeerskyP2PMD"
!macroend

; SHCNE_ASSOCCHANGED, so Explorer shows the change without a restart.
!macro peerskyTellExplorer
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)"
!macroend

!macro customInstall
  !insertmacro peerskyAddP2pmdItem "text"
  !insertmacro peerskyAddP2pmdItem ".md"
  !insertmacro peerskyAddP2pmdItem ".markdown"
  !insertmacro peerskyAddP2pmdItem ".txt"
  !insertmacro peerskyTellExplorer
!macroend

; Also runs when an update replaces this version; the new installer adds the
; item again right after.
!macro customUnInstall
  !insertmacro peerskyRemoveP2pmdItem "text"
  !insertmacro peerskyRemoveP2pmdItem ".md"
  !insertmacro peerskyRemoveP2pmdItem ".markdown"
  !insertmacro peerskyRemoveP2pmdItem ".txt"
  !insertmacro peerskyTellExplorer
!macroend
