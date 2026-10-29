#!/usr/bin/env python3
"""iPhone Shortcuts for the TV: "Note to TV" (asks, then sends), "Clear TV note", and for the shopping list "Add to TV
list" (asks: one item, or several with commas) and "TV shopping list" (shows it; the ones you pick are ticked off).

    python3 scripts/make_shortcuts.py    # → out/shortcuts/*.shortcut, signed; AirDrop them to the phone

They carry worker_url (tv.properties) and worker_phone_token (config.properties: one of the Worker's ADMIN_TOKEN list,
the phone's own, so it can be revoked alone). The files hold that token: they stay in out/ (not in git); delete them
once they're on the phone. Like make note, they work from home only (the Worker's ALLOWED_IPS).
"""
import os
import plistlib
import subprocess
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tvconfig  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'out', 'shortcuts')


def text(s):
    return {'Value': {'string': s}, 'WFSerializationType': 'WFTextTokenString'}


def output_of(action_uuid, name):
    """A text field holding another action's output (Shortcuts' "magic variable")."""
    return {'Value': {'string': '￼', 'attachmentsByRange': {'{0, 1}': {'OutputUUID': action_uuid, 'Type': 'ActionOutput', 'OutputName': name}}},
            'WFSerializationType': 'WFTextTokenString'}


def variable(action_uuid, name):
    """A whole other action's output, as an action's input."""
    return {'Value': {'OutputUUID': action_uuid, 'Type': 'ActionOutput', 'OutputName': name}, 'WFSerializationType': 'WFTextTokenAttachment'}


def dictionary(items):
    return {'Value': {'WFDictionaryFieldValueItems': [{'WFItemType': 0, 'WFKey': text(k), 'WFValue': v} for k, v in items]},
            'WFSerializationType': 'WFDictionaryFieldValue'}


def action(identifier, **params):
    params.setdefault('UUID', str(uuid.uuid4()).upper())
    return {'WFWorkflowActionIdentifier': identifier, 'WFWorkflowActionParameters': params}


def request(url, method, token, json_items=None):
    params = {'WFURL': url, 'WFHTTPMethod': method, 'ShowHeaders': True,
              'WFHTTPHeaders': dictionary([('Authorization', text('Bearer ' + token)), ('Content-Type', text('application/json'))])}
    if json_items:
        params.update(WFHTTPBodyType='JSON', WFJSONValues=dictionary(json_items))
    return action('is.workflow.actions.downloadurl', **params)


def workflow(actions, glyph, color):
    return {
        'WFWorkflowActions': actions, 'WFWorkflowClientVersion': '2302.0.4', 'WFWorkflowMinimumClientVersion': 900,
        'WFWorkflowMinimumClientVersionString': '900', 'WFWorkflowIcon': {'WFWorkflowIconGlyphNumber': glyph, 'WFWorkflowIconStartColor': color},
        'WFWorkflowImportQuestions': [], 'WFWorkflowTypes': [], 'WFWorkflowInputContentItemClasses': ['WFStringContentItem'],
    }


def main():
    # A name (python3 scripts/make_shortcuts.py Mariam) builds that person's, with worker_phone_token_mariam, in
    # out/shortcuts/Mariam; without one, the first phone's (worker_phone_token) in out/shortcuts.
    who = sys.argv[1] if len(sys.argv) > 1 else ''
    key = 'worker_phone_token' + ('_' + who.lower() if who else '')
    secrets_only = tvconfig.read(tvconfig.SECRETS)
    values = tvconfig.settings()
    url, token = values.get('worker_url', ''), secrets_only.get(key, '')
    if not url or not token:
        sys.exit('Needs worker_url in tv.properties and %s in config.properties.' % key)
    out = os.path.join(OUT, who) if who else OUT
    notes = url.rstrip('/') + '/v1/notes'

    ask = action('is.workflow.actions.ask', WFAskActionPrompt='Note for the TV (up to 140 characters)', WFInputType='Text')
    send = request(notes, 'POST', token, [('text', output_of(ask['WFWorkflowActionParameters']['UUID'], 'Ask for Input'))])
    shown = action('is.workflow.actions.showresult', Text=output_of(send['WFWorkflowActionParameters']['UUID'], 'Contents of URL'))
    clear = request(notes, 'DELETE', token)
    cleared = action('is.workflow.actions.showresult', Text=output_of(clear['WFWorkflowActionParameters']['UUID'], 'Contents of URL'))

    lst = url.rstrip('/') + '/v1/list'
    uid = lambda a: a['WFWorkflowActionParameters']['UUID']  # noqa: E731
    item = action('is.workflow.actions.ask', WFAskActionPrompt='Add to the list (commas for more than one)', WFInputType='Text')
    add = request(lst, 'POST', token, [('add', output_of(uid(item), 'Ask for Input'))])
    added = action('is.workflow.actions.getvalueforkey', WFInput=variable(uid(add), 'Contents of URL'), WFDictionaryKey='summary')
    shown_list = action('is.workflow.actions.showresult', Text=output_of(uid(added), 'Dictionary Value'))
    read = request(lst, 'GET', token)
    names = action('is.workflow.actions.getvalueforkey', WFInput=variable(uid(read), 'Contents of URL'), WFDictionaryKey='names')
    pick = action('is.workflow.actions.choosefromlist', WFInput=variable(uid(names), 'Dictionary Value'),
                  WFChooseFromListActionPrompt='Tick off what you bought', WFChooseFromListActionSelectMultiple=True)
    done = request(lst, 'POST', token, [('done', output_of(uid(pick), 'Chosen Item'))])
    left = action('is.workflow.actions.getvalueforkey', WFInput=variable(uid(done), 'Contents of URL'), WFDictionaryKey='summary')
    shown_left = action('is.workflow.actions.showresult', Text=output_of(uid(left), 'Dictionary Value'))

    os.makedirs(out, exist_ok=True)
    for name, flow in [('Note to TV', workflow([ask, send, shown], 59511, 4282601983)),
                       ('Clear TV note', workflow([clear, cleared], 59446, 4271458815)),
                       ('Add to TV list', workflow([item, add, added, shown_list], 59511, 2846468607)),
                       ('TV shopping list', workflow([read, names, pick, done, left, shown_left], 59511, 2846468607))]:
        raw = os.path.join(out, name + ' (unsigned).shortcut')
        signed = os.path.join(out, name + '.shortcut')
        fd = os.open(raw, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'wb') as f:
            plistlib.dump(flow, f, fmt=plistlib.FMT_BINARY)
        result = subprocess.run(['shortcuts', 'sign', '--mode', 'anyone', '--input', raw, '--output', signed],
                                capture_output=True, text=True)
        os.unlink(raw)
        if result.returncode != 0 or not os.path.exists(signed):
            sys.exit('Signing "%s" failed: %s' % (name, (result.stderr or result.stdout).strip()[:300]))
        os.chmod(signed, 0o600)
        print('Built', signed)
    print('AirDrop them to %s iPhone, add them, then delete %s (they hold the phone\'s key).'
          % (who + "'s" if who else 'the', os.path.relpath(out, os.path.dirname(OUT))))


if __name__ == '__main__':
    main()
