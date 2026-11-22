; Extra steps for the Windows installer (Tauri runs these NSIS hooks).

; Uninstalling also removes the "Start with Windows" entry, which would
; otherwise keep pointing at the deleted app. The value name matches RUN_VALUE
; in src/platform/windows.rs.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "NothingXMac"
!macroend
