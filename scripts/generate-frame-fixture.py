#!/usr/bin/env python3
"""Deterministic position-coded source for host frame qualification (stdlib only)."""
from pathlib import Path
import struct
import zlib


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


def main():
    width, height = 3200, 1800
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            # Independent X/Y ramps plus an asymmetric quadrant code.
            row.extend((16 + round(224*x/(width-1)), 16 + round(224*y/(height-1)), 32 + 64*(x >= width/2) + 128*(y >= height/2)))
        rows.append(row)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')
    (Path(__file__).resolve().parent.parent/'contracts/v1/fixtures/images/geometry-3200x1800.png').write_bytes(png)


if __name__ == '__main__':
    main()
