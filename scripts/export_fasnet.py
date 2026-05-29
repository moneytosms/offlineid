#!/usr/bin/env python3
"""Export the FASNet liveness models from PyTorch to ONNX.

Two checkpoints from ``minivision-ai/Silent-Face-Anti-Spoofing`` are exported.
Contrary to a common misreading, the two scales use **different architectures**:

* scale 2.7 -> ``2.7_80x80_MiniFASNetV2.pth``      (MiniFASNetV2)
* scale 4.0 -> ``4_0_0_80x80_MiniFASNetV1SE.pth``  (MiniFASNetV1SE)

Both take an 80x80 BGR crop and emit 3 logits. Per Silent-Face's own inference
code (``test.py``), the predictions of both models are summed and ``argmax`` is
taken; **class index 1 is the live/real face** (indices 0 and 2 are spoof types).
The native module therefore reads softmax index 1 as the real-face probability.

Run from the ``scripts/`` directory after fetching the weights::

    # weights live under Silent-Face-Anti-Spoofing/{src/model_lib, resources/anti_spoof_models}
    python export_fasnet.py

Outputs:  ``../models/fasnet_2_7.onnx``, ``../models/fasnet_4_0.onnx``
"""
import os
import sys

import torch

_LIB = os.path.join("Silent-Face-Anti-Spoofing", "src", "model_lib")
sys.path.insert(0, _LIB)
from MiniFASNet import MiniFASNetV2, MiniFASNetV1SE  # noqa: E402


def export_fasnet(model: torch.nn.Module, pth_path: str, onnx_path: str, label: str) -> None:
    """Load a checkpoint into ``model`` and export it to ONNX.

    Args:
        model:     An instantiated (un-loaded) MiniFASNet variant.
        pth_path:  Path to the PyTorch state-dict checkpoint.
        onnx_path: Destination ONNX file path.
        label:     Human-readable scale label for log output.
    """
    # weights_only=True blocks arbitrary code execution during unpickling.
    state = torch.load(pth_path, map_location="cpu", weights_only=True)
    # Strip the 'module.' prefix if the checkpoint was saved with DataParallel.
    state = {k.replace("module.", ""): v for k, v in state.items()}
    # Older SE checkpoints use flat se_fc1/se_bn1 names; the model nests them
    # under se_module.* . Remap so load_state_dict matches.
    remapped = {}
    for k, v in state.items():
        for old, new in (
            ("se_fc1", "se_module.fc1"),
            ("se_fc2", "se_module.fc2"),
            ("se_bn1", "se_module.bn1"),
            ("se_bn2", "se_module.bn2"),
        ):
            if old in k:
                k = k.replace(old, new)
                break
        remapped[k] = v
    model.load_state_dict(remapped)
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
    """Export both FASNet scales (V2 @ 2.7, V1SE @ 4.0) to separate ONNX files."""
    root = os.path.join("Silent-Face-Anti-Spoofing", "resources", "anti_spoof_models")
    os.makedirs("../models", exist_ok=True)

    export_fasnet(
        MiniFASNetV2(conv6_kernel=(5, 5)),
        os.path.join(root, "2.7_80x80_MiniFASNetV2.pth"),
        "../models/fasnet_2_7.onnx",
        "scale=2.7 (MiniFASNetV2)",
    )
    export_fasnet(
        MiniFASNetV1SE(conv6_kernel=(5, 5)),
        os.path.join(root, "4_0_0_80x80_MiniFASNetV1SE.pth"),
        "../models/fasnet_4_0.onnx",
        "scale=4.0 (MiniFASNetV1SE)",
    )
    # Shipped as two ONNX files; the native module loads both at startup and
    # averages their P(real) = softmax[1].


if __name__ == "__main__":
    main()
