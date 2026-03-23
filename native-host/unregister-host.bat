@echo off
:: Reamlet native messaging host — unregistration script
:: Removes registry entries for all supported Chromium-based browsers.

setlocal EnableDelayedExpansion

set "REG_KEY_NAME=com.reamlet.chromeBridge"

set BROWSERS[0]=HKCU\Software\Google\Chrome\NativeMessagingHosts
set BROWSERS[1]=HKCU\Software\Microsoft\Edge\NativeMessagingHosts
set BROWSERS[2]=HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts
set BROWSERS[3]=HKCU\Software\Vivaldi\NativeMessagingHosts
set BROWSERS[4]=HKCU\Software\Opera Software\Opera\NativeMessagingHosts
set BROWSERS[5]=HKCU\Software\Opera Software\Opera GX\NativeMessagingHosts

for /L %%i in (0,1,5) do (
    reg delete "!BROWSERS[%%i]!\%REG_KEY_NAME%" /f >nul 2>&1
    if !ERRORLEVEL! == 0 (
        echo Removed: !BROWSERS[%%i]!
    )
)

echo.
echo Unregistration complete.
pause
