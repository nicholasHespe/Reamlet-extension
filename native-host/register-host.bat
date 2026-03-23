@echo off
:: Reamlet native messaging host — registration script
:: Run this script once after extracting the portable build, or after moving it.
:: It writes the host manifest path into the Windows registry for every supported
:: Chromium-based browser.
::
:: Usage: register-host.bat  (double-click or run from an elevated prompt)

setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
:: Remove trailing backslash
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "HOST_EXE=%SCRIPT_DIR%\reamlet-native-host.exe"
set "MANIFEST=%SCRIPT_DIR%\com.reamlet.chromeBridge.json"

if not exist "%HOST_EXE%" (
    echo ERROR: reamlet-native-host.exe not found in %SCRIPT_DIR%
    echo Make sure the host executable is in the same folder as this script.
    pause
    exit /b 1
)

:: Write the manifest with the actual exe path (escape backslashes for JSON)
set "JSON_PATH=%HOST_EXE:\=\\%"
(
  echo {
  echo   "name": "com.reamlet.chromeBridge",
  echo   "description": "Reamlet native messaging host",
  echo   "path": "%JSON_PATH%",
  echo   "type": "stdio",
  echo   "allowed_origins": [
  echo     "chrome-extension://PLACEHOLDER_CHROME_ID/",
  echo     "chrome-extension://PLACEHOLDER_EDGE_ID/",
  echo     "chrome-extension://PLACEHOLDER_BRAVE_ID/"
  echo   ]
  echo }
) > "%MANIFEST%"

set "REG_VALUE=%MANIFEST%"
set "REG_KEY_NAME=com.reamlet.chromeBridge"

:: ── Register for each supported Chromium browser ─────────────

set BROWSERS[0]=HKCU\Software\Google\Chrome\NativeMessagingHosts
set BROWSERS[1]=HKCU\Software\Microsoft\Edge\NativeMessagingHosts
set BROWSERS[2]=HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts
set BROWSERS[3]=HKCU\Software\Vivaldi\NativeMessagingHosts
set BROWSERS[4]=HKCU\Software\Opera Software\Opera\NativeMessagingHosts
set BROWSERS[5]=HKCU\Software\Opera Software\Opera GX\NativeMessagingHosts

for /L %%i in (0,1,5) do (
    reg add "!BROWSERS[%%i]!\%REG_KEY_NAME%" /ve /t REG_SZ /d "%REG_VALUE%" /f >nul 2>&1
    if !ERRORLEVEL! == 0 (
        echo Registered: !BROWSERS[%%i]!
    ) else (
        echo Skipped ^(browser not installed^): !BROWSERS[%%i]!
    )
)

echo.
echo Registration complete. Restart your browser if it was open.
pause
