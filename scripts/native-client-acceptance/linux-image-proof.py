#!/usr/bin/env python3
"""Decode pixels received by an installed client on the owned virtual display."""
import json
import sys
from pathlib import Path
import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf

picture = GdkPixbuf.Pixbuf.new_from_file(sys.argv[1])
fixture = json.loads(Path(sys.argv[2]).read_text())
receipt = json.loads(sys.argv[3])
expected = (224, 48, 64) if not fixture['clicks'] else (32, 192, 96)
tolerance = 0 if receipt['primaryImage']['mimeType'] == 'image/png' else 12
pixels, stride, channels = picture.get_pixels(), picture.get_rowstride(), picture.get_n_channels()
points = []
for y in range(picture.get_height()):
    for x in range(picture.get_width()):
        offset = y*stride+x*channels
        if all(abs(a-b) <= tolerance for a,b in zip(pixels[offset:offset+3], expected)):
            points.append((x,y))
assert points, 'received client image has no fixture target'
box = [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points)+1, max(p[1] for p in points)+1]
point = [(box[0]+box[2])/2, (box[1]+box[3])/2]
assert receipt['geometry']['state'] == 'available'
regions = [r for r in receipt['geometry']['regions'] if r['imageRect']['x'] <= point[0] < r['imageRect']['x']+r['imageRect']['width'] and r['imageRect']['y'] <= point[1] < r['imageRect']['y']+r['imageRect']['height']]
assert len(regions) == 1
region = regions[0]
source, desktop = region['imageRect'], region['desktopRect']
mapped = [desktop[axis]+(point[k]-source[axis])*desktop[size]/source[size] for k,(axis,size) in enumerate([('x','width'),('y','height')])]
expected_point = [fixture['origin'][0]+80,fixture['origin'][1]+60]
assert max(abs(a-b) for a,b in zip(mapped,expected_point)) <= 1
resized = picture.scale_simple(640,480,GdkPixbuf.InterpType.BILINEAR)
normalized = [point[0]/picture.get_width(), point[1]/picture.get_height()]
resized_point = [round(normalized[0]*640),round(normalized[1]*480)]
offset = resized_point[1]*resized.get_rowstride()+resized_point[0]*resized.get_n_channels()
sample = list(resized.get_pixels()[offset:offset+3])
assert max(abs(a-b) for a,b in zip(sample,expected)) <= max(tolerance,1)
print(json.dumps({'imagePoint':point,'desktopPoint':mapped,'independentExpectedPoint':expected_point,'targetBounds':box,'colorTolerance':tolerance,'actualReceivedPixelsVerified':True,'clientResize':{'dimensions':[640,480],'normalizedPoint':normalized,'sample':sample,'mappingPreserved':True}}))
