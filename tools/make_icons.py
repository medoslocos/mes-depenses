"""Génère les icônes PNG de l'appli (sans dépendance : PNG écrit à la main).

Usage : python tools/make_icons.py   (depuis la racine du projet)
"""
import math
import struct
import zlib


def png(path, size, pixel):
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            row += bytes(pixel(x, y, size))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(data)


def coverage(u, v):
    """1 si le point (u, v) ∈ [0,1]² est sur le symbole €, sinon 0."""
    cx, cy = 0.56, 0.5
    dx, dy = u - cx, v - cy
    r = math.hypot(dx, dy)
    ang = math.degrees(math.atan2(-dy, dx))  # 0° à droite, sens trigo
    ring = 0.215 <= r <= 0.29 and not (-42 <= ang <= 42)
    bar1 = 0.17 <= u <= 0.62 and 0.405 <= v <= 0.46
    bar2 = 0.17 <= u <= 0.58 and 0.54 <= v <= 0.595
    return 1.0 if (ring or bar1 or bar2) else 0.0


def pixel(x, y, size, ss=4):
    # fond : dégradé bleu nuit → bleu
    t = (x + y) / (2 * size)
    bg = (int(18 + 30 * t), int(32 + 70 * t), int(80 + 150 * t))
    acc = 0.0
    for i in range(ss):
        for j in range(ss):
            acc += coverage((x + (i + 0.5) / ss) / size, (y + (j + 0.5) / ss) / size)
    a = acc / (ss * ss)
    return tuple(int(bg[k] * (1 - a) + 255 * a) for k in range(3))


if __name__ == "__main__":
    for s, name in [(180, "icon-180.png"), (192, "icon-192.png"), (512, "icon-512.png")]:
        png(name, s, pixel)
        print("ok", name)
