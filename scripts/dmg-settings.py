"""Saved Finder metadata, written directly; no Finder/AppleScript automation."""
import json
from pathlib import Path

config_path = Path(defines['config'])
config = json.loads(config_path.read_text())
layout = config['bundle']['macOS']['dmg']
app = defines['app']
app_name = Path(app).name
files = [app]
symlinks = {'Applications': '/Applications'}
format = 'UDZO'
filesystem = 'HFS+'
background = str(Path(defines['assets']) / layout['background'])
icon = str(Path(defines['assets']) / 'icons/icon.icns')
icon_size = 112
text_size = 14
arrange_by = None
window_rect = (
    (layout['windowPosition']['x'], layout['windowPosition']['y']),
    (layout['windowSize']['width'], layout['windowSize']['height']),
)
icon_locations = {
    app_name: (layout['appPosition']['x'], layout['appPosition']['y']),
    'Applications': (layout['applicationFolderPosition']['x'], layout['applicationFolderPosition']['y']),
}
# Finder normally hides .app extensions. Setting FinderInfo on the signed app
# here would invalidate codesign --strict, so leave the bundle untouched.
hide_extensions = []
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
default_view = 'icon-view'
include_icon_view_settings = True
include_list_view_settings = False
