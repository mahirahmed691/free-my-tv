#!/usr/bin/env python3
"""A reminder on your phone to EXTEND Developer Mode: Apple's Reminders (iCloud syncs it to the iPhone).

    python3 scripts/devmode_reminder.py <devmode-until ms>    # run by make release

Due 7 days before Developer Mode runs out (the TV removes developer apps then), at 7 pm. The one it made before is
replaced, so each release leaves exactly one. Does nothing without the date, or off macOS.

Where Reminders refuses (the terminal isn't allowed under Privacy & Security > Automation), it opens a calendar event
instead, which needs no permission: Calendar asks once to add it. Its UID stays the same, so a later one replaces it.
"""
import datetime
import os
import subprocess
import sys

NAME = 'Extend LG Developer Mode (Free My TV)'
BODY = 'Developer Mode app on the TV > EXTEND, or the TV removes developer apps.'
ICS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'out', 'devmode-reminder.ics')


def calendar_event(due, stamp):
    """An iCalendar event at the due time, with an alert."""
    start = due.strftime('%Y%m%dT%H%M%S')
    return '\r\n'.join([
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Free My TV//Developer Mode//EN', 'BEGIN:VEVENT',
        'UID:devmode-reminder@freemytv.local', 'DTSTAMP:' + stamp.strftime('%Y%m%dT%H%M%SZ'), 'SEQUENCE:%d' % stamp.timestamp(),
        'DTSTART:' + start, 'DURATION:PT15M', 'SUMMARY:' + NAME, 'DESCRIPTION:' + BODY,
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + NAME, 'TRIGGER:PT0M', 'END:VALARM',
        'END:VEVENT', 'END:VCALENDAR', '']).replace('EXTEND,', 'EXTEND\\,')


def open_event(due):
    os.makedirs(os.path.dirname(ICS), exist_ok=True)
    with open(ICS, 'w', encoding='utf-8', newline='') as f:
        f.write(calendar_event(due, datetime.datetime.now(datetime.timezone.utc)))
    subprocess.run(['open', ICS], timeout=30)
    print('Reminders is not allowed, so Calendar is adding it instead: %s. Accept it there.' % due.strftime('%a %d %b, %H:%M'))


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
        open_event(due)


if __name__ == '__main__':
    main()
