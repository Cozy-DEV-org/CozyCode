; CozyCode NSIS installer hooks.
; On install: register the "Open with CozyCode" context menu + add the install
; dir to the user PATH (so `cozy` / `cozycode` work). On uninstall: remove them.

!macro NSIS_HOOK_POSTINSTALL
  ; --- context menu (HKCU, no admin) ---
  WriteRegStr HKCU "Software\Classes\*\shell\CozyCode" "" "Open with CozyCode"
  WriteRegStr HKCU "Software\Classes\*\shell\CozyCode" "Icon" "$INSTDIR\cozycode.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\CozyCode\command" "" '"$INSTDIR\cozycode.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\CozyCode" "" "Open with CozyCode"
  WriteRegStr HKCU "Software\Classes\Directory\shell\CozyCode" "Icon" "$INSTDIR\cozycode.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\CozyCode\command" "" '"$INSTDIR\cozycode.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\CozyCode" "" "Open with CozyCode"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\CozyCode" "Icon" "$INSTDIR\cozycode.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\CozyCode\command" "" '"$INSTDIR\cozycode.exe" "%V"'

  ; --- CLI shims: cozy.cmd / cozycode.cmd (PATH is added at runtime by install_cli) ---
  FileOpen $0 "$INSTDIR\cozy.cmd" w
  FileWrite $0 '@echo off$\r$\nstart "" "$INSTDIR\cozycode.exe" %*$\r$\n'
  FileClose $0
  FileOpen $0 "$INSTDIR\cozycode.cmd" w
  FileWrite $0 '@echo off$\r$\nstart "" "$INSTDIR\cozycode.exe" %*$\r$\n'
  FileClose $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Classes\*\shell\CozyCode"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\CozyCode"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\CozyCode"
  Delete "$INSTDIR\cozy.cmd"
  Delete "$INSTDIR\cozycode.cmd"
!macroend
