import base64
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
import subprocess
import sys
import tempfile
from PIL import Image, ImageDraw, ImageCms

spec = importlib.util.spec_from_file_location('image_proof', Path(__file__).with_name('image-proof.py'))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class NativeImageProofTests(unittest.TestCase):
    def replace_image(self, result, image, **save_options):
        stream = io.BytesIO()
        image.save(stream, format='PNG', **save_options)
        raw = stream.getvalue()
        result['content'][0]['data'] = base64.b64encode(raw).decode()
        result['details']['observationV1']['primaryImage'].update(byteLength=len(raw), sha256=hashlib.sha256(raw).hexdigest())

    def vector(self):
        image = Image.new('RGB', (640, 512), (20, 40, 80))
        ImageDraw.Draw(image).rectangle((40, 72, 159, 151), fill=(224, 48, 64))
        landmarks = [{'name': name, 'rect': [x,y,16,16], 'rgb': list(rgb)} for name,x,y,rgb in [('NW',4,4,(40,210,220)),('NE',620,4,(200,60,210)),('SW',4,448,(250,145,30)),('SE',620,448,(225,235,250))]]
        for marker in landmarks:
            x,y,w,h = marker['rect']; ImageDraw.Draw(image).rectangle((x,y+32,x+w-1,y+32+h-1),fill=tuple(marker['rgb']))
        stream = io.BytesIO(); image.save(stream, format='PNG'); raw = stream.getvalue()
        result = {'content': [{'type': 'image', 'mimeType': 'image/png', 'data': base64.b64encode(raw).decode()}], 'details': {'observationV1': {
            'primaryImage': {'byteLength': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'mimeType': 'image/png', 'sourceDimensions': {'width': 640, 'height': 512}},
            'actualScope': {'state': 'unavailable'}, 'geometry': {'state': 'available', 'regions': [{'imageRect': {'x': 0, 'y': 0, 'width': 640, 'height': 512}, 'desktopRect': {'x': 120, 'y': 388, 'width': 640, 'height': 512}}]}}}}
        fixture = {'targetRect': [40, 40, 120, 80], 'desktopRect': {'x': 120, 'y': 420, 'width': 640, 'height': 480}, 'windowFrameRect': {'x': 120, 'y': 388, 'width': 640, 'height': 512}, 'backingScale': 1, 'fixtureSize': [640,480], 'landmarks': landmarks}
        return result, fixture

    def test_real_pixel_geometry_and_client_resize_map_to_independent_target(self):
        result, fixture = self.vector()
        value = proof.inspect_image(result, fixture)
        self.assertEqual(value['desktopPoint'], [220, 500])
        self.assertTrue(value['clientResize']['normalizedMappingPreserved'])
        self.assertFalse(value['effectVerified'])
        self.assertEqual(len(value['landmarks']),4)
        self.assertEqual(value['landmarks'][0]['desktopPoint'],[132,432])

    def test_wrong_mapping_cannot_pass_from_helper_success(self):
        result, fixture = self.vector()
        result['details']['observationV1']['geometry']['regions'][0]['desktopRect']['x'] += 80
        with self.assertRaises(AssertionError): proof.inspect_image(result, fixture)

    def test_unavailable_geometry_cannot_be_treated_as_identity(self):
        result, fixture = self.vector(); result['details']['observationV1']['geometry'] = {'state': 'unavailable'}
        with self.assertRaises(AssertionError): proof.inspect_image(result, fixture)

    def test_absent_pixels_and_wrong_capture_hash_are_rejected(self):
        result, fixture = self.vector()
        changed = copy.deepcopy(result); changed['content'] = []
        with self.assertRaises(AssertionError): proof.inspect_image(changed, fixture)
        result['details']['observationV1']['primaryImage']['sha256'] = '0'*64
        with self.assertRaises(AssertionError): proof.inspect_image(result, fixture)

    def test_red_pixels_cannot_prove_a_green_clicked_target(self):
        result, fixture = self.vector()
        with self.assertRaises(AssertionError): proof.inspect_image(result, fixture, 'clicked')

    def test_broader_screen_capture_cannot_prove_requested_window_scope(self):
        result, fixture = self.vector()
        image = Image.new('RGB', (1280, 960), (20, 40, 80))
        ImageDraw.Draw(image).rectangle((160, 460, 279, 539), fill=(224, 48, 64))
        stream = io.BytesIO(); image.save(stream, format='PNG'); raw = stream.getvalue()
        result['content'][0]['data'] = base64.b64encode(raw).decode()
        receipt = result['details']['observationV1']
        receipt['primaryImage'].update({'byteLength': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'sourceDimensions': {'width': 1280, 'height': 960}})
        receipt['geometry']['regions'] = [{'imageRect': {'x': 0, 'y': 0, 'width': 1280, 'height': 960}, 'desktopRect': {'x': 0, 'y': 0, 'width': 1280, 'height': 960}}]
        with self.assertRaises(AssertionError): proof.inspect_image(result, fixture)

    def test_missing_landmark_cannot_pass_from_a_correct_target(self):
        result,fixture=self.vector();fixture['landmarks'].pop()
        with self.assertRaises(AssertionError):proof.inspect_image(result,fixture)

    def test_wrong_landmark_geometry_cannot_pass_from_a_correct_target(self):
        result,fixture=self.vector();fixture['landmarks'][0]['rect'][0]+=30
        with self.assertRaises(AssertionError):proof.inspect_image(result,fixture)

    def test_retina_mapping_with_decoration_and_negative_origin(self):
        result,fixture=self.vector()
        original=Image.open(io.BytesIO(base64.b64decode(result['content'][0]['data'])))
        image=original.resize((1280,1024),Image.Resampling.NEAREST)
        stream=io.BytesIO();image.save(stream,format='PNG');raw=stream.getvalue()
        result['content'][0]['data']=base64.b64encode(raw).decode()
        receipt=result['details']['observationV1'];receipt['primaryImage'].update(byteLength=len(raw),sha256=hashlib.sha256(raw).hexdigest(),sourceDimensions={'width':1280,'height':1024})
        receipt['geometry']['regions'][0]['imageRect'].update(width=1280,height=1024)
        receipt['geometry']['regions'][0]['desktopRect']['x']=-300
        fixture['windowFrameRect']['x']=-300;fixture['desktopRect']['x']=-300;fixture['backingScale']=2
        value=proof.inspect_image(result,fixture)
        self.assertEqual(value['landmarks'][0]['imagePoint'],[24,88])
        self.assertEqual(value['landmarks'][0]['desktopPoint'],[-288,432])
        self.assertEqual(value['deliveredPixelsPerPoint'],2)

    def test_jpeg_landmarks_use_declared_color_tolerance(self):
        result,fixture=self.vector();image=Image.open(io.BytesIO(base64.b64decode(result['content'][0]['data'])))
        stream=io.BytesIO();image.save(stream,format='JPEG',quality=95);raw=stream.getvalue()
        result['content'][0].update(data=base64.b64encode(raw).decode(),mimeType='image/jpeg')
        result['details']['observationV1']['primaryImage'].update(byteLength=len(raw),sha256=hashlib.sha256(raw).hexdigest(),mimeType='image/jpeg')
        value=proof.inspect_image(result,fixture);self.assertEqual(len(value['landmarks']),4);self.assertEqual(value['colorTolerance'],16)

    def test_hidden_or_partial_target_cannot_supply_an_input_coordinate(self):
        for alpha, profiled in [(0, False), (127, False), (0, True)]:
            with self.subTest(alpha=alpha, profiled=profiled):
                result, fixture = self.vector()
                image = Image.open(io.BytesIO(base64.b64decode(result['content'][0]['data']))).convert('RGBA')
                ImageDraw.Draw(image).rectangle((40, 72, 159, 151), fill=(224, 48, 64, alpha))
                options = {'icc_profile': ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()} if profiled else {}
                self.replace_image(result, image, **options)
                with self.assertRaisesRegex(AssertionError, 'opaque'):
                    proof.inspect_image(result, fixture)

    def test_any_target_perimeter_or_interior_transparency_is_rejected(self):
        for point in [(40, 72), (159, 151), (100, 112)]:
            with self.subTest(point=point):
                result, fixture = self.vector()
                image = Image.open(io.BytesIO(base64.b64decode(result['content'][0]['data']))).convert('RGBA')
                image.putpixel(point, (224, 48, 64, 254))
                self.replace_image(result, image)
                with self.assertRaisesRegex(AssertionError, 'opaque'):
                    proof.inspect_image(result, fixture)

    def test_declared_target_is_checked_beyond_a_small_detected_color_patch(self):
        result, fixture = self.vector()
        image = Image.open(io.BytesIO(base64.b64decode(result['content'][0]['data']))).convert('RGBA')
        draw = ImageDraw.Draw(image)
        draw.rectangle((40, 72, 159, 151), fill=(20, 40, 80, 0))
        draw.rectangle((90, 102, 109, 121), fill=(224, 48, 64, 255))
        self.replace_image(result, image)
        with self.assertRaisesRegex(AssertionError, 'opaque'):
            proof.inspect_image(result, fixture)

    def test_landmark_center_and_perimeter_must_be_opaque(self):
        for point in [(12, 44), (4, 36), (635, 495)]:
            with self.subTest(point=point):
                result, fixture = self.vector()
                image = Image.open(io.BytesIO(base64.b64decode(result['content'][0]['data']))).convert('RGBA')
                red, green, blue, _ = image.getpixel(point)
                image.putpixel(point, (red, green, blue, 0))
                self.replace_image(result, image)
                with self.assertRaisesRegex(AssertionError, 'opaque'):
                    proof.inspect_image(result, fixture)

    def test_palette_transparency_cannot_hide_the_correct_target_rgb(self):
        result, fixture = self.vector()
        image = Image.open(io.BytesIO(base64.b64decode(result['content'][0]['data']))).convert('P', palette=Image.Palette.ADAPTIVE, colors=16)
        self.replace_image(result, image, transparency=image.getpixel((100, 112)))
        with self.assertRaisesRegex(AssertionError, 'opaque'):
            proof.inspect_image(result, fixture)

    def test_transparent_decoration_outside_proof_regions_is_allowed(self):
        result, fixture = self.vector()
        image = Image.open(io.BytesIO(base64.b64decode(result['content'][0]['data']))).convert('RGBA')
        image.putpixel((0, 0), (20, 40, 80, 0))
        self.replace_image(result, image)
        value = proof.inspect_image(result, fixture)
        self.assertEqual(value['desktopPoint'], [220, 500])

    def test_color_patch_must_match_the_complete_independent_target_extent(self):
        for rect in [(90, 102, 109, 121), (30, 62, 169, 161)]:
            with self.subTest(rect=rect):
                result, fixture = self.vector()
                image = Image.open(io.BytesIO(base64.b64decode(result['content'][0]['data']))).convert('RGB')
                draw = ImageDraw.Draw(image)
                draw.rectangle((40, 72, 159, 151), fill=(20, 40, 80))
                draw.rectangle(rect, fill=(224, 48, 64))
                self.replace_image(result, image)
                with self.assertRaisesRegex(AssertionError, 'target extent'):
                    proof.inspect_image(result, fixture)

    def test_optimized_python_cannot_disable_the_pre_input_proof(self):
        result, fixture = self.vector()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'result.json').write_text(json.dumps(result)); (root/'fixture.json').write_text(json.dumps(fixture))
            child = subprocess.run([sys.executable, '-I', '-O', str(Path(__file__).with_name('image-proof.py')), '--result', str(root/'result.json'), '--fixture-state', str(root/'fixture.json'), '--output', str(root/'proof.json')], capture_output=True, text=True, timeout=10)
            self.assertNotEqual(child.returncode, 0)
            self.assertIn('non-optimized', child.stderr)
            self.assertFalse((root/'proof.json').exists())


if __name__ == '__main__': unittest.main()
