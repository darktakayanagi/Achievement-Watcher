!include "MUI2.nsh"

Var APPDATA_MYAPP
Var OBS_APPDATA

!macro customHeader
  !undef MUI_HEADERIMAGE_BITMAP
  !undef MUI_HEADERIMAGE_BITMAP_RIGHT
  
  !define MUI_HEADERIMAGE_BITMAP "${BUILD_RESOURCES_DIR}\installerSidebar.bmp"
  !define MUI_HEADERIMAGE_BITMAP_RIGHT
!macroend

!insertmacro MUI_PAGE_WELCOME


Section "Close OBS if running"

  ; Try to close OBS gracefully first
  ExecWait 'taskkill /IM obs64.exe /T /F'

SectionEnd

Section "Install"

  ; Copy media, presets, view to your app's AppData
  StrCpy $APPDATA_MYAPP "$APPDATA\Achievement Watcher"
  CreateDirectory "$APPDATA_MYAPP"

SectionEnd


