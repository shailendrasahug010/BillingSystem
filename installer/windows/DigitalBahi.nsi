; DigitalBahi-Setup.exe: installs Digital Bahi for the current Windows user
; (no administrator rights), with Start menu and desktop shortcuts and an entry
; in Settings > Apps for uninstalling. The first start (DigitalBahi.cmd) gets
; Node.js and PostgreSQL when the computer has none and sets up the database.
;
; Built by installer/build-bundle.mjs --target win32-x64 --exe, which passes:
;   -DVERSION=0.1.0 -DBUNDLE_FILES=<the built folder>\*.* -DOUTFILE=<the .exe>

Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef BUNDLE_FILES
  !error "BUNDLE_FILES (the files of the folder build-bundle.mjs made) is required"
!endif
!ifndef OUTFILE
  !define OUTFILE "DigitalBahi-Setup.exe"
!endif
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\DigitalBahi"
!define DATA "$LOCALAPPDATA\DigitalBahi"
!define STOP 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\launcher\DigitalBahi.ps1" stop'

Name "Digital Bahi"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\DigitalBahi"
InstallDirRegKey HKCU "Software\DigitalBahi" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "Digital Bahi ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Digital Bahi"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "Digital Bahi setup"
VIAddVersionKey "LegalCopyright" "Digital Bahi"

!define MUI_ICON "digitalbahi.ico"
!define MUI_UNICON "digitalbahi.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Digital Bahi"
!define MUI_WELCOMEPAGE_TEXT "Aapke Business ka Digital Hisab.$\r$\n$\r$\nThis installs Digital Bahi on this computer, for you (no administrator rights needed).$\r$\n$\r$\nThe first start gets what Digital Bahi needs when this computer does not have it (Node.js and PostgreSQL, about 70 MB from the internet, only once), sets up Digital Bahi's own database, and opens the app in your browser. Later starts take a few seconds.$\r$\n$\r$\nYour data stays on this computer, in $LOCALAPPDATA\DigitalBahi."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Start Digital Bahi now"
!define MUI_FINISHPAGE_RUN_FUNCTION StartApp
!define MUI_FINISHPAGE_TEXT "Digital Bahi is installed.$\r$\n$\r$\nStart it from the Digital Bahi icon on the desktop or in the Start menu: it opens in your browser. $\"Stop Digital Bahi$\" in the Start menu stops it.$\r$\n$\r$\nTo install it as an app with its own window, click Install app in the menu on the left once it is open (Chrome or Edge)."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function StartApp
  ExecShell "open" "$INSTDIR\DigitalBahi.cmd" "start"
FunctionEnd

Section "Digital Bahi"
  ; A running copy holds its files open: stop it before replacing them.
  IfFileExists "$INSTDIR\launcher\DigitalBahi.ps1" 0 fresh
    DetailPrint "Stopping the running Digital Bahi..."
    nsExec::ExecToLog '${STOP}'
    Pop $0
    ; The old version's files go (the new one may not have them all); the data folder stays.
    RMDir /r "$INSTDIR\api"
    RMDir /r "$INSTDIR\web"
    RMDir /r "$INSTDIR\launcher"
  fresh:

  SetOutPath "$INSTDIR"
  File /r "${BUNDLE_FILES}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\Digital Bahi"
  CreateShortcut "$SMPROGRAMS\Digital Bahi\Digital Bahi.lnk" "$INSTDIR\DigitalBahi.cmd" "start" "$INSTDIR\digitalbahi.ico" 0 SW_SHOWMINIMIZED
  CreateShortcut "$SMPROGRAMS\Digital Bahi\Stop Digital Bahi.lnk" "$INSTDIR\DigitalBahi.cmd" "stop" "$INSTDIR\digitalbahi.ico" 0 SW_SHOWMINIMIZED
  CreateShortcut "$SMPROGRAMS\Digital Bahi\Digital Bahi data folder.lnk" "${DATA}"
  CreateShortcut "$SMPROGRAMS\Digital Bahi\Uninstall Digital Bahi.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\Digital Bahi.lnk" "$INSTDIR\DigitalBahi.cmd" "start" "$INSTDIR\digitalbahi.ico" 0 SW_SHOWMINIMIZED

  WriteRegStr HKCU "Software\DigitalBahi" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Digital Bahi"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Digital Bahi"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\digitalbahi.ico"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  DetailPrint "Stopping Digital Bahi..."
  nsExec::ExecToLog '${STOP}'
  Pop $0

  Delete "$DESKTOP\Digital Bahi.lnk"
  RMDir /r "$SMPROGRAMS\Digital Bahi"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\DigitalBahi"

  ; The data (bills, customers, stock, ledgers) is kept unless asked: a later install picks it up again.
  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Also delete Digital Bahi's data on this computer (all bills, customers, stock and ledgers in ${DATA})?$\r$\n$\r$\nThis cannot be undone. Choose No to keep it: installing Digital Bahi again brings it back." /SD IDNO IDYES wipe
    ; Downloaded programs (Node.js, PostgreSQL) can always be fetched again.
    RMDir /r "${DATA}\runtime"
    Goto done
  wipe:
    RMDir /r "${DATA}"
  done:
SectionEnd
