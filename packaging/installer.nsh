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

  WriteRegStr HKCU "Software\Classes\Applications\Linsoft Browser.exe" "FriendlyAppName" "Linsoft Browser"
  WriteRegStr HKCU "Software\Classes\Applications\Linsoft Browser.exe\shell\open\command" "" "$\"$INSTDIR\Linsoft Browser.exe$\" $\"%1$\""
  WriteRegStr HKCU "Software\Classes\Applications\Linsoft Browser.exe\SupportedTypes" ".html" ""
  WriteRegStr HKCU "Software\Classes\Applications\Linsoft Browser.exe\SupportedTypes" ".htm" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  SetShellVarContext all
  Delete "$DESKTOP\Linsoft Browser.lnk"
  Delete "$DESKTOP\Linsoft Browser 2.0.lnk"
  Delete "$SMPROGRAMS\Linsoft Browser\Linsoft Browser.lnk"
  Delete "$SMPROGRAMS\Linsoft Browser\Linsoft Browser 2.0.lnk"
  Delete "$SMPROGRAMS\Linsoft Browser\Linsoft Browser (Uninstall).lnk"
  Delete "$INSTDIR\linsoft-browser-icon.ico"
  DeleteRegKey HKCU "Software\Classes\Applications\Linsoft Browser.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  RMDir "$SMPROGRAMS\Linsoft Browser"
!macroend
