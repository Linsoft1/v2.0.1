!macro customInstall
  SetShellVarContext all
  Delete "$DESKTOP\Linsoft Browser.lnk"
  Delete "$DESKTOP\Linsoft Browser 2.0.lnk"
  Delete "$SMPROGRAMS\Linsoft Browser\Linsoft Browser.lnk"
  Delete "$SMPROGRAMS\Linsoft Browser\Linsoft Browser 2.0.lnk"
  Delete "$SMPROGRAMS\Linsoft Browser\Linsoft Browser (Uninstall).lnk"
  RMDir /r "$SMPROGRAMS\Linsoft Browser"

  CreateDirectory "$SMPROGRAMS\Linsoft Browser"
  CopyFiles "$INSTDIR\resources\app.asar.unpacked\assets\linsoft-icon.ico" "$INSTDIR\linsoft-browser-icon.ico"

  CreateShortCut "$DESKTOP\Linsoft Browser.lnk" "$INSTDIR\Linsoft Browser.exe" "" "$INSTDIR\linsoft-browser-icon.ico" 0
  CreateShortCut "$SMPROGRAMS\Linsoft Browser\Linsoft Browser.lnk" "$INSTDIR\Linsoft Browser.exe" "" "$INSTDIR\linsoft-browser-icon.ico" 0
  CreateShortCut "$SMPROGRAMS\Linsoft Browser\Linsoft Browser (Uninstall).lnk" "$INSTDIR\uninst.exe" "" "$INSTDIR\linsoft-browser-icon.ico" 0
!macroend

!macro customUnInstall
  SetShellVarContext all
  Delete "$DESKTOP\Linsoft Browser.lnk"
  Delete "$DESKTOP\Linsoft Browser 2.0.lnk"
  Delete "$SMPROGRAMS\Linsoft Browser\Linsoft Browser.lnk"
  Delete "$SMPROGRAMS\Linsoft Browser\Linsoft Browser 2.0.lnk"
  Delete "$SMPROGRAMS\Linsoft Browser\Linsoft Browser (Uninstall).lnk"
  Delete "$INSTDIR\linsoft-browser-icon.ico"
  RMDir "$SMPROGRAMS\Linsoft Browser"
!macroend
