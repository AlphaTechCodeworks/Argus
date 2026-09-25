@echo off
rem TVT network search helper for the CCTV app (Sites > Find NVRs). Leave this window open.
cd /d "%~dp0"
node cctv\discovery-helper.mjs
pause
