@echo off
chcp 65001 >nul
title Crane Sim - 3D 양중 시뮬레이터
cd /d "%~dp0"

echo ============================================
echo   Crane Sim  -  3D 양중 시뮬레이터
echo ============================================
echo.

REM Node.js 설치 확인
where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js가 설치되어 있지 않습니다.
  echo        https://nodejs.org 에서 설치 후 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

REM 의존성 설치 (최초 1회 또는 node_modules 없을 때)
if not exist "node_modules" (
  echo [설치] 의존성을 처음 설치합니다. 잠시 기다려 주세요...
  call npm install
  if errorlevel 1 (
    echo [오류] npm install 실패.
    pause
    exit /b 1
  )
  echo.
)

echo [실행] 개발 서버를 시작합니다...
echo        브라우저가 자동으로 열립니다. 종료하려면 이 창에서 Ctrl+C.
echo.

REM 서버가 뜰 시간을 준 뒤 브라우저 자동 오픈
start "" cmd /c "timeout /t 3 >nul & start http://localhost:5173"

REM Vite 개발 서버 (이 창에서 계속 실행됨)
call npm run dev

pause
