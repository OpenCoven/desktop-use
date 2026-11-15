#!/usr/bin/env python3
"""Verify only fixture-owned images; write metadata without captured pixels."""
import argparse
import base64
import hashlib
import io
import json
import math
from pathlib import Path
from PIL import Image, ImageCms


def require_opaque_box(alpha, box):
    assert len(box) == 4 and all(math.isfinite(value) for value in box), 'finite proof bounds required'
    left, top, right, bottom = box
    assert 0 <= left < right <= alpha.width and 0 <= top < bottom <= alpha.height, 'proof region must be contained in the received image'
    bounds = (math.floor(left), math.floor(top), math.ceil(right), math.ceil(bottom))
    assert alpha.crop(bounds).getextrema() == (255, 255), 'every proof-region pixel must be opaque before color conversion'
    return bounds


def declared_region_box(rect, fixture, extent):
    assert len(rect) == 4 and all(math.isfinite(value) for value in rect), 'finite fixture region required'
    x, y, width, height = rect
    assert width > 0 and height > 0 and x >= 0 and y >= 0 and x+width <= fixture['fixtureSize'][0] and y+height <= fixture['fixtureSize'][1]
    content, desktop, image = fixture['desktopRect'], extent['desktopRect'], extent['imageRect']
    left = image['x']+(content['x']+x-desktop['x'])*image['width']/desktop['width']
    top = image['y']+(content['y']+y-desktop['y'])*image['height']/desktop['height']
    return (left, top, left+width*image['width']/desktop['width'], top+height*image['height']/desktop['height'])


def verify_landmarks(picture, alpha, fixture, extent, tolerance):
    landmarks = fixture.get('landmarks', [])
    assert len(landmarks) == 4 and {marker['name'] for marker in landmarks} == {'NW', 'NE', 'SW', 'SE'}, 'four labelled fixture landmarks required'
    content, desktop, image = fixture['desktopRect'], extent['desktopRect'], extent['imageRect']
    proofs = []
    for marker in landmarks:
        x,y,width,height = marker['rect']
        opaque_bounds = require_opaque_box(alpha, declared_region_box(marker['rect'], fixture, extent))
        expected = [content['x']+x+width/2, content['y']+y+height/2]
        point = [image[axis]+(expected[k]-desktop[axis])*image[size]/desktop[size] for k,(axis,size) in enumerate([('x','width'),('y','height')])]
        px,py = map(round,point)
        assert 0 <= px < picture.width and 0 <= py < picture.height
        sample = picture.getpixel((px,py))
        assert max(abs(a-b) for a,b in zip(sample,marker['rgb'])) <= tolerance, 'landmark pixels contradict the independent fixture coordinates'
        proofs.append({'name':marker['name'],'imagePoint':point,'desktopPoint':expected,'sampleSRGB':sample,'opaquePixelBounds':opaque_bounds})
    return proofs


def inspect_image(result, fixture, expected='initial'):
    if not __debug__:
        raise RuntimeError('pre-input image verification requires non-optimized Python')
    details = result.get('details', result.get('structuredContent', result))
    receipt = details['observationV1']
    images = [c for c in result.get('content', []) if c.get('type') == 'image']
    assert len(images) == 1, 'one actual typed image is required'
    image = images[0]
    raw = base64.b64decode(image['data'], validate=True)
    primary = receipt['primaryImage']
    assert len(raw) == primary['byteLength']
    assert hashlib.sha256(raw).hexdigest() == primary['sha256']
    assert image['mimeType'] == primary['mimeType']
    picture = Image.open(io.BytesIO(raw))
    picture.load()
    assert picture.size == (primary['sourceDimensions']['width'], primary['sourceDimensions']['height'])
    # Keep the decoded alpha, including palette/tRNS transparency, before ICC
    # conversion or RGB normalization can discard it. Only proof regions need
    # to be opaque; unrelated decorated-window corners may be transparent.
    alpha = picture.convert('RGBA').getchannel('A')
    icc = picture.info.get('icc_profile')
    if icc:
        picture = ImageCms.profileToProfile(picture, ImageCms.ImageCmsProfile(io.BytesIO(icc)), ImageCms.createProfile('sRGB'), outputMode='RGB')
    else:
        picture = picture.convert('RGB')
    color = (224, 48, 64) if expected == 'initial' else (32, 192, 96)
    # The display ICC conversion and 8-bit capture dithering are independent of
    # lossless PNG encoding; declare the color tolerance rather than claiming
    # that device-space bytes equal the fixture's sRGB constants.
    tolerance = 16
    points = [(x, y) for y in range(picture.height) for x in range(picture.width)
              if all(abs(a-b) <= tolerance for a, b in zip(picture.getpixel((x, y)), color))]
    assert points, 'known fixture target pixels are absent'
    box = (min(x for x, y in points), min(y for x, y in points), max(x for x, y in points)+1, max(y for x, y in points)+1)
    require_opaque_box(alpha, box)
    assert len(points) / ((box[2]-box[0])*(box[3]-box[1])) > .90, 'target color does not form the expected filled rectangle'
    point = ((box[0]+box[2])/2, (box[1]+box[3])/2)
    geometry = receipt['geometry']
    assert geometry['state'] == 'available', 'unavailable mapping cannot become identity'
    frame = fixture['windowFrameRect']
    assert len(geometry['regions']) == 1, 'one owned window must fill the capture'
    extent = geometry['regions'][0]
    assert extent['imageRect'] == {'x': 0, 'y': 0, 'width': picture.width, 'height': picture.height}
    assert all(abs(extent['desktopRect'][axis]-frame[axis]) <= 1 for axis in ['x', 'y', 'width', 'height']), 'capture extent must match the independent AppKit window frame'
    scale = picture.width/frame['width']
    assert abs(scale-picture.height/frame['height']) <= .01, 'window pixels must use uniform scale'
    assert any(abs(scale-allowed) <= .01 for allowed in [1, fixture['backingScale']]), 'pixel scale must match the independent fixture display'
    matching = [r for r in geometry['regions'] if r['imageRect']['x'] <= point[0] < r['imageRect']['x']+r['imageRect']['width'] and r['imageRect']['y'] <= point[1] < r['imageRect']['y']+r['imageRect']['height']]
    assert len(matching) == 1, 'target must belong to one mapping region'
    region = matching[0]
    source, desktop = region['imageRect'], region['desktopRect']
    mapped = [desktop[axis] + (point[k]-source[axis])*desktop[size]/source[size] for k, (axis, size) in enumerate([('x', 'width'), ('y', 'height')])]
    target = fixture['targetRect']
    declared_target_bounds = require_opaque_box(alpha, declared_region_box(target, fixture, extent))
    assert max(abs(a-b) for a,b in zip(box, declared_target_bounds)) <= 2*scale, 'detected target extent contradicts the independent fixture rectangle'
    expected_point = [fixture['desktopRect']['x']+target[0]+target[2]/2, fixture['desktopRect']['y']+target[1]+target[3]/2]
    assert max(abs(a-b) for a,b in zip(mapped, expected_point)) <= 2, (mapped, expected_point)
    landmarks = verify_landmarks(picture, alpha, fixture, extent, tolerance)
    # A real consumer resize of these received pixels retains the normalized
    # position. This is client-resize evidence, not a gateway-history claim.
    resized = picture.resize((320, 256), Image.Resampling.LANCZOS)
    resized_point = [point[0]*resized.width/picture.width, point[1]*resized.height/picture.height]
    sample = resized.getpixel(tuple(round(p) for p in resized_point))
    assert max(abs(a-b) for a,b in zip(sample, color)) <= tolerance
    recovered = [resized_point[0]/resized.width*picture.width, resized_point[1]/resized.height*picture.height]
    assert max(abs(a-b) for a,b in zip(point, recovered)) < 1e-8
    return {'sha256': primary['sha256'], 'mimeType': image['mimeType'], 'byteLength': len(raw), 'dimensions': picture.size,
            'colorManaged': bool(icc), 'landmarks': landmarks, 'colorTolerance': tolerance, 'targetPixelBounds': box, 'declaredTargetOpaquePixelBounds': declared_target_bounds, 'proofRegionsOpaque': True, 'imagePoint': point, 'desktopPoint': mapped,
            'independentExpectedDesktopPoint': expected_point, 'geometryState': geometry['state'], 'actualScope': receipt['actualScope'],
            'independentWindowExtentVerified': True, 'windowFrameRect': frame, 'deliveredPixelsPerPoint': scale,
            'clientResize': {'dimensions': resized.size, 'targetPoint': resized_point, 'sampleSRGB': sample, 'normalizedMappingPreserved': True},
            'actualNativePixels': True, 'displayKind': fixture.get('session', 'macos-session'), 'physicalDisplayVerified': False, 'effectVerified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--result', type=Path, required=True)
    parser.add_argument('--fixture-state', type=Path, required=True)
    parser.add_argument('--expected', choices=['initial', 'clicked'], default='initial')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    proof = inspect_image(json.loads(args.result.read_text()), json.loads(args.fixture_state.read_text()), args.expected)
    args.output.write_text(json.dumps(proof, indent=2)+'\n')
    print(json.dumps(proof))
