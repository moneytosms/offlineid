#!/usr/bin/env python3
"""Export & simplify the SCRFD-500M face detector for mobile deployment.

SCRFD-500M ships from the InsightFace ``buffalo_sc`` model pack already in
ONNX format (``det_500m.onnx``). This script:

1. Loads the raw ONNX graph.
2. Simplifies it with ``onnxsim`` and fixes the dynamic input shape to
   ``[1, 3, 640, 640]`` so the on-device runtime allocates a static buffer.
3. Saves the simplified graph and validates its input/output signature.

Run (from the ``scripts/`` directory)::

    python export_scrfd.py

Inputs / outputs
----------------
* Input :  ``../models/scrfd_500m_raw.onnx``   (copied from the buffalo_sc pack)
* Output:  ``../models/scrfd_500m_fixed.onnx``

Expected I/O after simplification::

    Inputs:  [('input.1', [1, 3, 640, 640])]
    Outputs: score_8, score_16, score_32,
             bbox_8,  bbox_16,  bbox_32,
             kps_8,   kps_16,   kps_32
"""
import os

import onnx
import onnxsim
import onnxruntime as ort

MODEL_IN = "../models/scrfd_500m_raw.onnx"
MODEL_OUT = "../models/scrfd_500m_fixed.onnx"


def main() -> None:
    """Simplify the SCRFD ONNX graph and validate the result."""
    model = onnx.load(MODEL_IN)
    model_simplified, check = onnxsim.simplify(
        model,
        input_shapes={"input.1": [1, 3, 640, 640]},  # fix dynamic shapes
        skip_shape_inference=False,
    )
    assert check, "ONNX simplification failed"
    onnx.save(model_simplified, MODEL_OUT)
    print(f"SCRFD saved: {MODEL_OUT}")
    print(f"Size: {os.path.getsize(MODEL_OUT) / 1024:.1f} KB")

    # Validate inputs/outputs
    sess = ort.InferenceSession(MODEL_OUT, providers=["CPUExecutionProvider"])
    print("Inputs:", [(i.name, i.shape) for i in sess.get_inputs()])
    print("Outputs:", [(o.name, o.shape) for o in sess.get_outputs()])
    # Expected inputs:  [('input.1', [1, 3, 640, 640])]
    # Expected outputs: score_8, score_16, score_32, bbox_8, bbox_16, bbox_32,
    #                   kps_8, kps_16, kps_32


if __name__ == "__main__":
    main()
