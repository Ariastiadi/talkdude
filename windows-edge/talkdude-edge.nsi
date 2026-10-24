; talkdude for Windows (Edge app). Installs the talkdude web app files, the
; small "talkdude helper" Edge extension (lets the talkdude page search the web
; and read links) and shortcuts that open the app in Microsoft Edge's app mode.
; No admin needed, and nothing unsigned runs after install (Edge runs the app),
; so Smart App Control does not block it.
; Build (see .github/workflows/release.yml): put the `vite build --base ./` output in app\
; and the app icon as talkdude.ico, then run: makensis -DVERSION=x.y.z talkdude-edge.nsi
Unicode true
!define APPNAME "talkdude"
!ifndef VERSION
  !define VERSION "dev"
!endif
Name "${APPNAME}"
OutFile "talkdude-windows-edge-setup.exe"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\talkdude-edge"
Icon "talkdude.ico"
UninstallIcon "talkdude.ico"
SetCompressor /SOLID lzma
ShowInstDetails nevershow

Var EDGE
Var URL

; Replace characters in a string: StrRep result "string" "from" "to"
!macro StrRep OUT STR FROM TO
  Push "${STR}"
  Push "${FROM}"
  Push "${TO}"
  Call StrRepFn
  Pop ${OUT}
!macroend
Function StrRepFn
  Exch $R2 ; to
  Exch 1
  Exch $R1 ; from
  Exch 2
  Exch $R0 ; string
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  StrCpy $R3 ""
  StrLen $R4 $R1
  loop:
    StrCmp $R0 "" done
    StrCpy $R5 $R0 $R4
    StrCmp $R5 $R1 hit
    StrCpy $R6 $R0 1
    StrCpy $R3 "$R3$R6"
    StrCpy $R0 $R0 "" 1
    Goto loop
  hit:
    StrCpy $R3 "$R3$R2"
    StrCpy $R0 $R0 "" $R4
    Goto loop
  done:
  StrCpy $R0 $R3
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "app\*.*"
  File "talkdude.ico"
  SetOutPath "$INSTDIR\helper"
  File /r "helper\*.*"
  SetOutPath "$INSTDIR"

  ; Find Microsoft Edge.
  ReadRegStr $EDGE HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe" ""
  StrCmp $EDGE "" 0 +2
  ReadRegStr $EDGE HKCU "SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe" ""
  StrCmp $EDGE "" 0 +2
  StrCpy $EDGE "$PROGRAMFILES32\Microsoft\Edge\Application\msedge.exe"

  ; file:///C:/Users/.../index.html
  !insertmacro StrRep $URL "$INSTDIR\index.html" "\" "/"
  !insertmacro StrRep $URL "$URL" " " "%20"
  StrCpy $URL "file:///$URL"

  CreateDirectory "$LOCALAPPDATA\talkdude-edge"
  CreateShortCut "$SMPROGRAMS\talkdude.lnk" "$EDGE" '--app="$URL" --user-data-dir="$LOCALAPPDATA\talkdude-edge\profile" --load-extension="$INSTDIR\helper" --disable-features=DisableLoadExtensionCommandLineSwitch --allow-file-access-from-files --no-first-run' "$INSTDIR\talkdude.ico" 0
  CreateShortCut "$DESKTOP\talkdude.lnk" "$EDGE" '--app="$URL" --user-data-dir="$LOCALAPPDATA\talkdude-edge\profile" --load-extension="$INSTDIR\helper" --disable-features=DisableLoadExtensionCommandLineSwitch --allow-file-access-from-files --no-first-run' "$INSTDIR\talkdude.ico" 0

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\talkdude-edge" "DisplayName" "talkdude (Edge app)"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\talkdude-edge" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\talkdude-edge" "Publisher" "Ariastiadi"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\talkdude-edge" "DisplayIcon" "$INSTDIR\talkdude.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\talkdude-edge" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\talkdude-edge" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\talkdude-edge" "NoRepair" 1

  ; Open talkdude right away and close the installer.
  ExecShell "open" "$SMPROGRAMS\talkdude.lnk"
  SetAutoClose true
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\talkdude.lnk"
  Delete "$DESKTOP\talkdude.lnk"
  RMDir /r "$INSTDIR"
  ; Chats and settings stay in %LOCALAPPDATA%\talkdude-edge\profile so a reinstall keeps them.
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\talkdude-edge"
SectionEnd
