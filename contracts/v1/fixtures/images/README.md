# Image decoder fixtures

These synthetic 32 by 24 RGB images were generated locally with Pillow 13.0.0, using `((x*17+y*3)%256, (x*3+y*19)%256, (x*11+y*7)%256)` for each pixel. PNG uses the default lossless writer. JPEG uses quality 90; `progressive.jpg` adds `progressive=True`, and `restart.jpg` adds `restart_marker_blocks=1`. Baseline and restart fixtures contain byte-stuffed entropy. These are generated test assets, not captured desktop content.

`jpeg-missing-eoi.jpg` removes the baseline's final two EOI bytes. `jpeg-truncated-entropy.jpg` retains the baseline headers, only five bytes after the SOS header, and then EOI. The latter is deliberately structurally plausible but lacks the entropy needed for the declared image. Stock zune-jpeg 0.5.15 strict mode and jpeg-decoder 0.3.2 both accepted it; the vendored strict entropy correction rejects it. The valid baseline has 549 bytes of entropy before EOI; tests also reject every shorter prefix with a synthetic EOI.

Observation JSON fixtures in the sibling `observations` directory refer to the exact valid PNG/JPEG bytes and hashes here. They contain synthetic producer/provider identity and no native desktop geometry claim. Rust validates these bytes and compares the generated metadata with that shared corpus.
