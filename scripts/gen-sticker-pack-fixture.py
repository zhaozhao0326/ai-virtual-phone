# 生成自检用的表情包合集 PNG 样本（scripts/fixtures/sticker-pack.png）。
#
# 复刻真·QuPhone 导出结构：PNG 的 tEXt 块 key = "quphone"，
# 值是 base64(JSON)，JSON 形如
#   {"app":"QU PHONE","kind":"sticker","format":1,"exportedAt":<ms>,
#    "sticker":{"name":"<图集名>","items":[{"name","kind":"asset","src":"data:image/png;base64,..."}]}}
# 供 scripts/check-sticker-pack.mjs 断言解码结果。
#
# 需要 Pillow（仅用于生成样本，自检本身不依赖它）。
# 用法: python scripts/gen-sticker-pack-fixture.py

import struct, zlib, base64, json, io, os
from PIL import Image

OUT = "C:/Users/乖乖/WorkBuddy/2026-08-08-07-53-10/ai-virtual-phone/scripts/fixtures"
os.makedirs(OUT, exist_ok=True)

def tiny_png(color):
    buf = io.BytesIO()
    Image.new("RGBA", (8, 8), color).save(buf, format="PNG")
    return buf.getvalue()

def tiny_jpeg(color):
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), color).save(buf, format="JPEG")
    return buf.getvalue()

# 真·QuPhone 导出结构：
# tEXt key = "quphone"，value = base64(JSON)
# {"app":"QU PHONE","kind":"sticker","format":1,"exportedAt":<ms>,
#  "sticker":{"name":"<图集名>","items":[{"name","kind":"asset","src":"data:image/png;base64,..."}]}}
items = [
    {"name": "开心", "kind": "asset", "src": "data:image/png;base64," + base64.b64encode(tiny_png((255, 80, 80, 255))).decode("ascii")},
    {"name": "难过", "kind": "asset", "src": "data:image/png;base64," + base64.b64encode(tiny_png((80, 120, 255, 255))).decode("ascii")},
    {"name": "摆烂", "kind": "asset", "src": "data:image/jpeg;base64," + base64.b64encode(tiny_jpeg((80, 200, 120))).decode("ascii")},
]
manifest = {
    "app": "QU PHONE",
    "kind": "sticker",
    "format": 1,
    "exportedAt": 1789620671525,
    "sticker": {"name": "测试合集", "items": items},
}
manifest_b64 = base64.b64encode(json.dumps(manifest, ensure_ascii=False).encode("utf-8")).decode("ascii")

# 载体 PNG（可见像素无所谓，元数据才是正文）
buf = io.BytesIO()
Image.new("RGBA", (64, 32), (240, 240, 240, 255)).save(buf, format="PNG")
png = bytearray(buf.getvalue())

body = b"quphone\x00" + manifest_b64.encode("latin1")
chunk = struct.pack(">I", len(body)) + b"tEXt" + body
chunk += struct.pack(">I", zlib.crc32(b"tEXt" + body) & 0xFFFFFFFF)

iend = png.rfind(b"IEND") - 4
final = png[:iend] + chunk + png[iend:]
out_path = os.path.join(OUT, "sticker-pack.png")
open(out_path, "wb").write(final)

print("wrote", out_path, len(final), "bytes")
print("packName: 测试合集 | items:", [i["name"] for i in items])
