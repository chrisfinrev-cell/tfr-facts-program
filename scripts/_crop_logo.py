from PIL import Image

src = r"C:\Users\ecci2\Projects\official-TFR-FACTS-program\public\tfr\tfr-logo.jpg"
im = Image.open(src).convert("RGB")
w, h = im.size
px = im.load()
print("corners", px[0, 0], px[w - 1, 0], px[0, h - 1], px[w // 2, h // 2])
minx, miny, maxx, maxy = w, h, 0, 0
for y in range(0, h, 1):
    for x in range(0, w, 1):
        r, g, b = px[x, y]
        sat = max(r, g, b) - min(r, g, b)
        lum = (r + g + b) / 3
        if sat > 36 or lum < 150:
            if x < minx:
                minx = x
            if y < miny:
                miny = y
            if x > maxx:
                maxx = x
            if y > maxy:
                maxy = y
pad = 20
minx = max(0, minx - pad)
miny = max(0, miny - pad)
maxx = min(w - 1, maxx + pad)
maxy = min(h - 1, maxy + pad)
crop = im.crop((minx, miny, maxx + 1, maxy + 1))
crop.save(src, quality=92)
print(f"cropped {w}x{h} -> {crop.size[0]}x{crop.size[1]} box=({minx},{miny},{maxx},{maxy})")
