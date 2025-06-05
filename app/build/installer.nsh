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

  CopyFiles /SILENT "$INSTDIR\resources\userData\Media\*" "$APPDATA_MYAPP\Media\"
  CopyFiles /SILENT "$INSTDIR\resources\userData\Presets\*" "$APPDATA_MYAPP\Presets\"
  CopyFiles /SILENT "$INSTDIR\resources\userData\view\*" "$APPDATA_MYAPP\view\"

  ; Define OBS base appdata path
  StrCpy $OBS_APPDATA "$APPDATA\obs-studio\basic"

  ; Create profiles and scenes folders if they don't exist
  CreateDirectory "$OBS_APPDATA\profiles"
  CreateDirectory "$OBS_APPDATA\scenes"

  ; Copy the profile folder recursively
  ExecWait 'xcopy /E /I /Y "$INSTDIR\resources\userData\obs\AW" "$OBS_APPDATA\profiles\AW"'

  ; Copy the scene JSON file
  CopyFiles /SILENT "$INSTDIR\resources\userData\obs\AW.json" "$OBS_APPDATA\scenes\"

SectionEnd


