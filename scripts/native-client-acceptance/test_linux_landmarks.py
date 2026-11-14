import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('linux_image_proof',Path(__file__).with_name('linux-image-proof.py'))
proof=importlib.util.module_from_spec(spec);spec.loader.exec_module(proof)

class LandmarkProofTests(unittest.TestCase):
 def example(self):
  fixture={'origin':[-100,20],'size':[640,480],'landmarks':[{'name':name,'rect':[x,y,16,16],'rgb':list(rgb)} for name,x,y,rgb in [('NW',4,4,(40,210,220)),('NE',620,4,(200,60,210)),('SW',4,448,(250,145,30)),('SE',620,448,(225,235,250))]],'controls':{'textEntry':[170,100,430,34],'scrollRegion':[170,180,430,230]}}
  receipt={'geometry':{'state':'available','regions':[{'imageRect':{'x':0,'y':0,'width':1280,'height':960},'desktopRect':{'x':-100,'y':20,'width':640,'height':480}}]}}
  colors={(24,24):(40,210,220),(1256,24):(200,60,210),(24,912):(250,145,30),(1256,912):(225,235,250)}
  return fixture,receipt,lambda x,y:colors.get((x,y),(0,0,0))
 def test_four_landmarks_verify_2x_pixels_and_negative_desktop_origin(self):
  f,r,sample=self.example();markers,controls=proof.prove_landmarks(f,r,1280,960,sample,0)
  self.assertEqual([p['imagePoint'] for p in markers],[[24,24],[1256,24],[24,912],[1256,912]])
  self.assertEqual(controls['textEntry'],[285,137])
 def test_shifted_mapping_cannot_authorize_control_points(self):
  f,r,sample=self.example();r['geometry']['regions'][0]['desktopRect']['x']+=10
  with self.assertRaises(AssertionError):proof.prove_landmarks(f,r,1280,960,sample,0)
 def test_wrong_landmark_color_fails(self):
  f,r,sample=self.example()
  with self.assertRaises(AssertionError):proof.prove_landmarks(f,r,1280,960,lambda x,y:(0,0,0),0)
 def test_outside_control_cannot_authorize_input(self):
  f,r,sample=self.example();f['controls']['textEntry']=[630,100,430,34]
  with self.assertRaises(AssertionError):proof.prove_landmarks(f,r,1280,960,sample,0)
 def test_missing_landmark_fails(self):
  f,r,sample=self.example();f['landmarks'].pop()
  with self.assertRaises(AssertionError):proof.prove_landmarks(f,r,1280,960,sample,0)
if __name__=='__main__':unittest.main()
