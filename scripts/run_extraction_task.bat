@echo off
rem 《病港》extraction 自動續跑任務
rem 由 Windows Task Scheduler 觸發；斷點續跑安全（ledger+cache 跳過已完成段落）
cd /d C:\Users\User\Desktop\benggong
echo === scheduled run started %date% %time% === >> data\private\review\run-full-book.log
"C:\Users\User\AppData\Local\Microsoft\WindowsApps\python3.12.exe" scripts\run_extraction.py >> data\private\review\run-full-book.log 2>&1
echo === scheduled run finished %date% %time% EXIT=%ERRORLEVEL% === >> data\private\review\run-full-book.log
