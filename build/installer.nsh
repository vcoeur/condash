; Custom electron-builder NSIS hook — append the install directory to
; the per-user PATH so `condash` and `condash-cli` are reachable from any
; shell, matching Linux's /usr/bin/condash[-cli] symlinks. See GitHub
; issue #119: prior installers wrote condash.exe + condash-cli.cmd into
; $INSTDIR but didn't touch PATH, leaving every condash-cli-shelling
; skill broken on Windows.
;
; electron-builder defaults: oneClick=true, perMachine=false → per-user
; install. Per-user PATH lives at HKCU\Environment\PATH and needs no
; admin token. If a future release switches to perMachine, this hook
; needs the HKLM equivalent (HKLM "System\CurrentControlSet\Control\Session Manager\Environment").

!include "LogicLib.nsh"
!include "StrFunc.nsh"
!include "WinMessages.nsh"

; StrFunc functions must be declared once before use. The Un-prefixed
; variants are required inside uninstaller-context macros.
${StrStr}
${UnStrStr}
${UnStrRep}

!macro customInstall
  Push $0
  Push $1
  ReadRegStr $0 HKCU "Environment" "PATH"
  ${If} $0 == ""
    WriteRegExpandStr HKCU "Environment" "PATH" "$INSTDIR"
  ${Else}
    ; Substring check — skip the write if $INSTDIR is already somewhere
    ; in PATH (idempotent reinstall). False positives are theoretically
    ; possible if another entry shares $INSTDIR as a prefix; install
    ; dirs don't collide that way in practice.
    ${StrStr} $1 "$0" "$INSTDIR"
    ${If} $1 == ""
      WriteRegExpandStr HKCU "Environment" "PATH" "$0;$INSTDIR"
    ${EndIf}
  ${EndIf}
  ; Broadcast WM_SETTINGCHANGE so already-running shells / Explorer pick
  ; up the new PATH without a logoff.
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  Pop $1
  Pop $0
!macroend

!macro customUnInstall
  Push $0
  Push $1
  ReadRegStr $0 HKCU "Environment" "PATH"
  ${If} $0 != ""
    ; Try semicolon-prefixed form first (most common: $INSTDIR appended
    ; to a non-empty PATH), then suffix form, then bare (only entry).
    ${UnStrRep} $1 "$0" ";$INSTDIR" ""
    ${If} $1 == $0
      ${UnStrRep} $1 "$0" "$INSTDIR;" ""
    ${EndIf}
    ${If} $1 == $0
      ${UnStrRep} $1 "$0" "$INSTDIR" ""
    ${EndIf}
    WriteRegExpandStr HKCU "Environment" "PATH" "$1"
  ${EndIf}
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  Pop $1
  Pop $0
!macroend
