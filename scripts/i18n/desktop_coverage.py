"""Refresh the language picker after adding desktop or editor messages."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DESKTOP = ROOT / 'desktop/src/locales'
EDITOR = ROOT / 'src/components/i18n/locales'


def messages(path):
    return json.loads(path.read_text(encoding='utf-8'))


def refresh():
    shell_keys = messages(DESKTOP / 'en.json').keys()
    editor_keys = messages(EDITOR / 'en.json').keys()
    complete = []
    for catalog in sorted(DESKTOP.glob('*.json')):
        shell = messages(catalog)
        editor = messages(EDITOR / catalog.name)
        if all(shell.get(k, '').strip() for k in shell_keys) and all(editor.get(k, '').strip() for k in editor_keys):
            complete.append(catalog.stem)

    # Only this small index is needed to render the picker. Catalogs stay lazy-loaded.
    (DESKTOP.parent / 'complete-locales.json').write_text(json.dumps(complete) + '\n', encoding='utf-8')


if __name__ == '__main__':
    refresh()
