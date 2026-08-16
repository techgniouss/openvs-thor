@echo off
setlocal enabledelayedexpansion

:: ============================================================================
:: OpenVS Build and Prerequisites Setup Script
:: Prepares dependencies, downloads Electron and built-in extensions,
:: copies assets, and compiles core sources and extensions.
:: ============================================================================

pushd %~dp0

echo =======================================================
echo          OpenVS Build and Setup Preparation
echo =======================================================
echo.

:: Parse optional arguments
set "BUILD_ALL_EXTENSIONS=0"
set "FORCE_CLEAN=0"
set "LAUNCH_AFTER_BUILD=0"

:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--all" set "BUILD_ALL_EXTENSIONS=1"
if /i "%~1"=="--all-extensions" set "BUILD_ALL_EXTENSIONS=1"
if /i "%~1"=="--clean" set "FORCE_CLEAN=1"
if /i "%~1"=="--run" set "LAUNCH_AFTER_BUILD=1"
if /i "%~1"=="-r" set "LAUNCH_AFTER_BUILD=1"
if /i "%~1"=="--help" goto show_help
if /i "%~1"=="-h" goto show_help
shift
goto parse_args

:show_help
echo Usage: build-openvs.bat [options]
echo.
echo Options:
echo   --all, --all-extensions  Compile all built-in extensions
echo   --clean                  Perform a clean build (removes out/ and reinstall modules)
echo   --run, -r                Launch OpenVS immediately after successful build
echo   --help, -h               Show this help message
echo.
popd
goto :eof

:args_done

:: ----------------------------------------------------------------------------
:: [1/7] Check Node.js and NPM environment
:: ----------------------------------------------------------------------------
echo [1/7] Checking environment...
where node >nul 2>&1
if errorlevel 1 goto :node_missing

where npm.cmd >nul 2>&1
if errorlevel 1 (
    where npm >nul 2>&1
    if errorlevel 1 goto :npm_missing
)

for /f "tokens=*" %%v in ('node -v') do set "NODE_VERSION=%%v"
echo       Found Node.js: %NODE_VERSION%
goto :check_modules

:node_missing
echo [ERROR] Node.js is not installed or not in your PATH.
echo Please install Node.js 20+ or 22+ from https://nodejs.org/
goto :error

:npm_missing
echo [ERROR] npm is not installed or not in your PATH.
goto :error

:check_modules
:: ----------------------------------------------------------------------------
:: [2/7] Check / Install Node Modules
:: ----------------------------------------------------------------------------
if "%FORCE_CLEAN%"=="1" (
    echo [2/7] Cleaning previous build and reinstalling dependencies...
    if exist out rmdir /s /q out
    if exist node_modules rmdir /s /q node_modules
)

if not exist node_modules (
    echo [2/7] Installing root dependencies via npm ci...
    call npm.cmd ci
    if errorlevel 1 (
        echo [WARN] npm ci failed, attempting npm install...
        call npm.cmd install --no-audit --no-fund
        if errorlevel 1 goto :error
    )
) else (
    echo [2/7] Dependencies in node_modules already present.
)

:: ----------------------------------------------------------------------------
:: [3/7] Check / Download Electron Binary
:: ----------------------------------------------------------------------------
set "ELECTRON_EXE="
if exist ".build\electron\Open VS.exe" set "ELECTRON_EXE=.build\electron\Open VS.exe"
if exist ".build\electron\Code - OSS.exe" set "ELECTRON_EXE=.build\electron\Code - OSS.exe"

if "%ELECTRON_EXE%"=="" (
    echo [3/7] Electron executable not found in .build\electron. Downloading Electron...
    call npm.cmd run electron
    if errorlevel 1 goto :error
) else (
    echo [3/7] Electron executable found: %ELECTRON_EXE%
)

:: ----------------------------------------------------------------------------
:: [4/7] Synchronize Built-in Extensions
:: ----------------------------------------------------------------------------
echo [4/7] Checking / Synchronizing built-in extensions...
call node build\lib\builtInExtensions.ts
if errorlevel 1 (
    echo [WARN] Built-in extensions sync returned non-zero code. Proceeding with existing extensions...
)

:: ----------------------------------------------------------------------------
:: [5/7] Copy Codicons and Static Assets
:: ----------------------------------------------------------------------------
echo [5/7] Copying codicons and UI font assets...
call node --experimental-strip-types --max-old-space-size=8192 ./node_modules/gulp/bin/gulp.js copy-codicons
if errorlevel 1 goto :error

:: ----------------------------------------------------------------------------
:: [6/7] Transpiling Core Source
:: ----------------------------------------------------------------------------
echo [6/7] Transpiling src/...
call node build\next\index.ts transpile
if errorlevel 1 goto :error

:: ----------------------------------------------------------------------------
:: [7/7] Compiling Extensions and Media
:: ----------------------------------------------------------------------------
echo [7/7] Compiling extensions...

echo       - Compiling extension media...
call node --experimental-strip-types --max-old-space-size=8192 ./node_modules/gulp/bin/gulp.js compile-extension-media
if errorlevel 1 goto :error

echo       - Compiling openvs-chat extension...
call node --experimental-strip-types --max-old-space-size=8192 ./node_modules/gulp/bin/gulp.js compile-extension:openvs-chat
if errorlevel 1 goto :error

if "%BUILD_ALL_EXTENSIONS%"=="1" (
    echo       - Compiling all built-in extensions...
    call node --experimental-strip-types --max-old-space-size=8192 ./node_modules/gulp/bin/gulp.js compile-extensions
    if errorlevel 1 goto :error
)

:: ----------------------------------------------------------------------------
:: Success and Launch Verification
:: ----------------------------------------------------------------------------
echo.
echo =======================================================
echo  [SUCCESS] OpenVS compilation and setup completed!
echo =======================================================
echo.
echo You can now launch OpenVS anytime by running:
echo     run-openvs.bat
echo.

if "%LAUNCH_AFTER_BUILD%"=="1" (
    echo Launching OpenVS now...
    call run-openvs.bat
)

popd
goto :eof

:error
echo.
echo =======================================================
echo  [ERROR] Build or prerequisite step failed!
echo =======================================================
echo Please check the error messages above for details.
popd
exit /b 1
