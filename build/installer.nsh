; electron-builder writes `protocols` only for macOS, so the installer registers
; voiceroom:// for the current user itself: links work before the first launch.
; The app re-registers the same key at startup (electron/deep-links.js).
!macro customInstall
  WriteRegStr HKCU "Software\Classes\voiceroom" "" "URL:Voice Room"
  WriteRegStr HKCU "Software\Classes\voiceroom" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\voiceroom\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\voiceroom\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

; Voice Room turns Windows autostart off by disabling its Run entry instead of
; deleting it (see electron/autostart.js), so the entry outlives the app switch.
; Remove it and its Task Manager approval state on a real uninstall. Updates run
; the old uninstaller too and must keep the user's autostart choice and the
; link handler.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"
    DeleteRegKey HKCU "Software\Classes\voiceroom"
  ${endIf}
!macroend
