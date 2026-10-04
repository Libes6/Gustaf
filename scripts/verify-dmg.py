"""Inspect a read-only mounted image without opening Finder."""
import json
import sys
from pathlib import Path
from ds_store import DSStore

mount = Path(sys.argv[1])
config = json.loads(Path(sys.argv[2]).read_text())
layout = config['bundle']['macOS']['dmg']
app_name = config['productName'] + '.app'
with DSStore.open(str(mount / '.DS_Store'), 'r') as store:
    options = store['.']['icvp']
    assert options['iconSize'] == 112
    assert options['backgroundType'] == 2
    assert options['labelOnBottom'] is True
    assert store[app_name]['Iloc'] == (layout['appPosition']['x'], layout['appPosition']['y'])
    assert store['Applications']['Iloc'] == (layout['applicationFolderPosition']['x'], layout['applicationFolderPosition']['y'])
    position, size = layout['windowPosition'], layout['windowSize']
    expected = '{{%d, %d}, {%d, %d}}' % (position['x'], position['y'], size['width'], size['height'])
    assert store['.']['bwsp']['WindowBounds'] == expected
assert (mount / 'Applications').readlink() == Path('/Applications')
assert (mount / app_name / 'Contents/Info.plist').is_file()
assert any(p.is_file() for p in mount.glob('.background*'))
print('DMG saved layout, background, app and Applications link verified.')
