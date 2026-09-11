; Voice Room turns Windows autostart off by disabling its Run entry instead of
; deleting it (see electron/autostart.js), so the entry outlives the app switch.
; Remove it and its Task Manager approval state on a real uninstall. Updates run
; the old uninstaller too and must keep the user's autostart choice.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"
  ${endIf}
!macroend
