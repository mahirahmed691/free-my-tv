#!/usr/bin/env python3
"""A reminder on your phone to EXTEND Developer Mode: Apple's Reminders (iCloud syncs it to the iPhone).

    python3 scripts/devmode_reminder.py <devmode-until ms>    # run by make release

Due 7 days before Developer Mode runs out (the TV removes developer apps then), at 7 pm. The one it made before is
replaced, so each release leaves exactly one. Does nothing without the date, or off macOS.
"""
import datetime
import subprocess
import sys

NAME = 'Extend LG Developer Mode (Free My TV)'


def main():
    if len(sys.argv) < 2 or not sys.argv[1].strip().isdigit() or sys.platform != 'darwin':
        return
    until = datetime.datetime.fromtimestamp(int(sys.argv[1]) / 1000)
    due = (until - datetime.timedelta(days=7)).replace(hour=19, minute=0, second=0, microsecond=0)
    if due < datetime.datetime.now():
        due = datetime.datetime.now() + datetime.timedelta(minutes=5)
    script = '''
on run argv
  set {theName, y, m, d, h} to argv
  set dueDate to current date
  set day of dueDate to 1
  set year of dueDate to y as integer
  set month of dueDate to m as integer
  set day of dueDate to d as integer
  set hours of dueDate to h as integer
  set minutes of dueDate to 0
  set seconds of dueDate to 0
  tell application "Reminders"
    delete (every reminder whose name is theName and completed is false)
    make new reminder with properties {name:theName, due date:dueDate, remind me date:dueDate, body:"Developer Mode app on the TV > EXTEND, or the TV removes Free My TV."}
  end tell
end run'''
    r = subprocess.run(['osascript', '-e', script, NAME, str(due.year), str(due.month), str(due.day), str(due.hour)],
                       capture_output=True, text=True, timeout=60)
    if r.returncode == 0:
        print('Reminder set for %s: %s' % (due.strftime('%a %d %b, %H:%M'), NAME))
    else:
        print('No reminder (Reminders said: %s)' % (r.stderr.strip()[:200] or 'no answer'))


if __name__ == '__main__':
    main()
