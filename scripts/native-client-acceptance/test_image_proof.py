import base64
import copy
import hashlib
import importlib.util
import io
from pathlib import Path
import unittest
from PIL import Image, ImageDraw

spec = importlib.util.spec_from_file_location('image_proof', Path(__file__).with_name('image-proof.py'))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class NativeImageProofTests(unittest.TestCase):
    def vector(self):
        image = Image.new('RGB', (640, 512), (20, 40, 80))
        ImageDraw.Draw(image).rectangle((40, 72, 159, 151), fill=(224, 48, 64))
        stream = io.BytesIO(); image.save(stream, format='PNG'); raw = stream.getvalue()
        result = {'content': [{'type': 'image', 'mimeType': 'image/png', 'data': base64.b64encode(raw).decode()}], 'details': {'observationV1': {
            'primaryImage': {'byteLength': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'mimeType': 'image/png', 'sourceDimensions': {'width': 640, 'height': 512}},
            'actualScope': {'state': 'unavailable'}, 'geometry': {'state': 'available', 'regions': [{'imageRect': {'x': 0, 'y': 0, 'width': 640, 'height': 512}, 'desktopRect': {'x': 120, 'y': 388, 'width': 640, 'height': 512}}]}}}}
        fixture = {'targetRect': [40, 40, 120, 80], 'desktopRect': {'x': 120, 'y': 420, 'width': 640, 'height': 480}, 'windowFrameRect': {'x': 120, 'y': 388, 'width': 640, 'height': 512}, 'backingScale': 1}
        return result, fixture

    def test_real_pixel_geometry_and_client_resize_map_to_independent_target(self):
        result, fixture = self.vector()
        value = proof.inspect_image(result, fixture)
        self.assertEqual(value['desktopPoint'], [220, 500])
        self.assertTrue(value['clientResize']['normalizedMappingPreserved'])
        self.assertFalse(value['effectVerified'])

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


if __name__ == '__main__': unittest.main()
