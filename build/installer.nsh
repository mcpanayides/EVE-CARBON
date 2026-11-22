; Hooks electron-builder calls from its own NSIS script.
;
; There was a customInstall here that offered to wipe everything before a "fresh
; install". It looked for the app under a registry key it has never used (the key
; is a GUID), so it never ran. Removed rather than repaired: the in-app update
; runs this installer, and an update must not ask whether to delete your characters.
;
; What the app writes, all under the USER's folders, whoever it is installed for:
;   %APPDATA%\EVE Carbon            the profile (Electron names it from productName)
;   %APPDATA%\EVE Carbon\sde        updated game data; downloads itself again
;   %APPDATA%\EVE Carbon Demo       the throwaway demo profile
;   %APPDATA%\eve-carbon            the profile's name in very old builds
;   %LOCALAPPDATA%\eve-carbon-updater   electron-builder's copy of the installer
;   %TEMP%\eve-carbon-sde-*         game-data updates that were cut off
;
; EC_* can be defined beforehand, so the removal can be tried on a scratch folder.
!ifndef EC_ROAMING
  !define EC_ROAMING "$APPDATA"
!endif
!ifndef EC_LOCAL
  !define EC_LOCAL "$LOCALAPPDATA"
!endif
!ifndef EC_TEMP
  !define EC_TEMP "$TEMP"
!endif

; Gone with the app, whatever the answer: nothing here is yours or can be used
; without it.
!macro ecRemoveRebuildable
  RMDir /r "${EC_ROAMING}\EVE Carbon\sde"
  RMDir /r "${EC_ROAMING}\EVE Carbon Demo"
  Delete "${EC_LOCAL}\eve-carbon-updater\installer.exe"
  RMDir "${EC_LOCAL}\eve-carbon-updater"
  Push $R8
  Push $R9
  FindFirst $R8 $R9 "${EC_TEMP}\eve-carbon-sde-*"
  ecTempLoop:
    StrCmp $R9 "" ecTempDone
    RMDir /r "${EC_TEMP}\$R9"
    FindNext $R8 $R9
    Goto ecTempLoop
  ecTempDone:
  FindClose $R8
  Pop $R9
  Pop $R8
!macroend

; Only on "Yes": characters, databases and settings.
!macro ecWipeUserData
  RMDir /r "${EC_ROAMING}\EVE Carbon"
  RMDir /r "${EC_ROAMING}\eve-carbon"
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller too (--updated). It must touch nothing here.
  ${ifNot} ${isUpdated}
    ; An all-users uninstall points $APPDATA at ProgramData; the data is the user's.
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}

    !insertmacro ecRemoveRebuildable

    ; "No" is the default button: until 4.1.4 "Yes" looked in the wrong folder
    ; and removed nothing, and now it does what it says.
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Do you want to completely wipe all saved characters, databases, and user settings?$\r$\n$\r$\nThis cannot be undone." \
      /SD IDNO IDNO ecKeepData
      !insertmacro ecWipeUserData
    ecKeepData:

    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endif}
!macroend
