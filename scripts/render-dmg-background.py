"""Optional artwork regeneration on macOS with Pillow; never run during builds."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent.parent
assets = root / 'apps/desktop/src-tauri/dmg'
scale = 2
image = Image.new('RGB', (720 * scale, 440 * scale), '#f3f1eb')
draw = ImageDraw.Draw(image)
fonts = Path('/System/Library/Fonts/Supplemental')

def text(x, y, value, size, color, bold=False):
    font = ImageFont.truetype(str(fonts / ('Arial Bold.ttf' if bold else 'Arial.ttf')), size * scale)
    draw.text((x * scale, y * scale), value, font=font, fill=color)

text(72, 49, 'Gustaf', 30, '#122941', True)
text(72, 91, 'Drag Gustaf to Applications to install.', 17, '#475565')
logo = Image.open(assets / 'brand-mark.png').convert('RGBA').resize((40 * scale, 40 * scale), Image.Resampling.LANCZOS)
image.paste(logo, (22 * scale, 46 * scale), logo)
draw.line([(315 * scale, 228 * scale), (398 * scale, 228 * scale)], fill='#788a9b', width=4 * scale)
draw.line([(382 * scale, 212 * scale), (398 * scale, 228 * scale), (382 * scale, 244 * scale)], fill='#788a9b', width=4 * scale)
draw.line([(36 * scale, 364 * scale), (684 * scale, 364 * scale)], fill='#d4d9dd', width=scale)
text(36, 389, 'Once installed, eject this disk and open Gustaf.', 13, '#566575')
image.save(assets / 'background@2x.png', dpi=(144, 144))
image.resize((720, 440), Image.Resampling.LANCZOS).save(assets / 'background.png', dpi=(72, 72))
