#!/usr/bin/env python3
"""Export the FASNet (MiniFASNetV2) liveness models from PyTorch to ONNX.

Two MiniFASNetV2 checkpoints from ``minivision-ai/Silent-Face-Anti-Spoofing``
are exported. Both share an identical architecture; only the crop scale of the
training data differs (2.7x vs 4.0x of the face bounding box). The native module
loads both and averages their softmax "real" scores.

Run (from the ``scripts/`` directory, with the Silent-Face repo cloned alongside)::

    git clone https://github.com/minivision-ai/Silent-Face-Anti-Spoofing
    python export_fasnet.py

Model contract
--------------
* Input :  ``(1, 3, 80, 80)``  BGR crop, normalised with ImageNet BGR stats
* Output:  ``(1, 3)``          logits -> softmax -> P(real) = class 0

Inputs / outputs
----------------
* Inputs :  ``Silent-Face-Anti-Spoofing/resources/anti_spoof_models/*.pth``
* Outputs:  ``../models/fasnet_2_7.onnx``, ``../models/fasnet_4_0.onnx``
"""
import os
import sys

import torch

sys.path.insert(0, "./Silent-Face-Anti-Spoofing/src/model_lib")
from MiniFASNet import MiniFASNetV2  # noqa: E402


def export_fasnet(pth_path: str, onnx_path: str, label: str) -> None:
    """Load a MiniFASNetV2 ``.pth`` checkpoint and export it to ONNX.

    Args:
        pth_path:  Path to the PyTorch state-dict checkpoint.
        onnx_path: Destination ONNX file path.
        label:     Human-readable scale label for log output.
    """
    model = MiniFASNetV2(conv6_kernel=(5, 5))
    # weights_only=True: checkpoints are plain tensor state-dicts; this blocks
    # arbitrary code execution during unpickling.
    state = torch.load(pth_path, map_location="cpu", weights_only=True)
    # Strip the 'module.' prefix if saved with DataParallel
    state = {k.replace("module.", ""): v for k, v in state.items()}
    model.load_state_dict(state)
    model.eval()

    dummy = torch.randn(1, 3, 80, 80)
    torch.onnx.export(
        model,
        dummy,
        onnx_path,
        input_names=["input"],
        output_names=["output"],
        opset_version=11,
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
    )
    size_kb = os.path.getsize(onnx_path) / 1024
    print(f"FASNet [{label}] saved: {onnx_path} ({size_kb:.1f} KB)")


def main() -> None:
    """Export both FASNet scales to separate ONNX files."""
    models_root = "./Silent-Face-Anti-Spoofing/resources/anti_spoof_models"
    export_fasnet(
        os.path.join(models_root, "2.7_80x80_MiniFASNetV2.pth"),
        "../models/fasnet_2_7.onnx",
        "scale=2.7",
    )
    export_fasnet(
        os.path.join(models_root, "4_0_80x80_MiniFASNetV2.pth"),
        "../models/fasnet_4_0.onnx",
        "scale=4.0",
    )
    # Shipped as two separate files (fasnet_2_7.onnx, fasnet_4_0.onnx).
    # The native module loads both at startup and averages their real scores.


if __name__ == "__main__":
    main()
