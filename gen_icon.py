# -*- coding: utf-8 -*-
"""生成 YJAI 应用图标 icon.ico（渐变圆角 + 「阅卷」汉字）"""
from PIL import Image, ImageDraw, ImageFont
import os, sys

SIZE = 512
img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))

# 渐变背景（左上蓝 -> 右下紫）
for y in range(SIZE):
    t = y / SIZE
    r = int(79 + (163 - 79) * t)
    g = int(140 + (113 - 140) * t)
    b = int(255 + (247 - 255) * t)
    ImageDraw.Draw(img).line([(0, y), (SIZE, y)], fill=(r, g, b, 255))

# 圆角遮罩
mask = Image.new('L', (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=112, fill=255)
img.putalpha(mask)

# 文字「阅卷」
font_path = None
for p in [r'C:\Windows\Fonts\simhei.ttf', r'C:\Windows\Fonts\msyhbd.ttc',
          r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\simsun.ttc']:
    if os.path.exists(p):
        font_path = p
        break
try:
    font = ImageFont.truetype(font_path, 190)
except Exception:
    font = ImageFont.load_default()

d = ImageDraw.Draw(img)
text = '阅卷'
bbox = d.textbbox((0, 0), text, font=font)
w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
fs = 190
while w > SIZE - 60 and fs > 60:
    fs -= 10
    font = ImageFont.truetype(font_path, fs)
    d = ImageDraw.Draw(img)
    bbox = d.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
d.text(((SIZE - w) / 2 - bbox[0], (SIZE - h) / 2 - bbox[1]), text, font=font, fill=(255, 255, 255, 255))

out = sys.argv[1] if len(sys.argv) > 1 else 'icon.ico'
img.save(out, format='ICO', sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print('icon saved:', out, os.path.getsize(out), 'bytes')
