#!/usr/bin/env python3
"""Benchmark all four exported ONNX models and write ``BENCHMARKS.md``.

For each model this script loads the ONNX session on the CPU execution
provider, runs 3 warm-up iterations, then times 20 inference passes on a random
input tensor of the correct shape. It records file size, average latency, and
P95 latency, then renders a Markdown summary table.

Run (from the ``scripts/`` directory)::

    python validate_models.py

Output
------
* ``../BENCHMARKS.md``  -- performance summary table
"""
import os
import time

import numpy as np
import onnxruntime as ort

MODELS = {
    "SCRFD-500M": ("../models/scrfd_500m_fixed.onnx", (1, 3, 640, 640)),
    "MobileFaceNet": ("../models/mobilefacenet_int8.onnx", (1, 3, 112, 112)),
    "FASNet-2.7": ("../models/fasnet_2_7.onnx", (1, 3, 80, 80)),
    "FASNet-4.0": ("../models/fasnet_4_0.onnx", (1, 3, 80, 80)),
}


def main() -> None:
    """Benchmark each model and emit ``BENCHMARKS.md``."""
    results = []

    for name, (path, shape) in MODELS.items():
        if not os.path.exists(path):
            print(f"[SKIP] {name}: {path} not found")
            continue
        size_mb = os.path.getsize(path) / (1024 * 1024)
        sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        inp_name = sess.get_inputs()[0].name
        dummy = np.random.randn(*shape).astype(np.float32)

        # Warmup
        for _ in range(3):
            sess.run(None, {inp_name: dummy})

        # Benchmark 20 runs
        times = []
        for _ in range(20):
            t0 = time.perf_counter()
            sess.run(None, {inp_name: dummy})
            times.append((time.perf_counter() - t0) * 1000)

        avg_ms = np.mean(times)
        p95_ms = np.percentile(times, 95)
        out_shapes = [str(o.shape) for o in sess.get_outputs()]
        print(
            f"{name}: size={size_mb:.2f} MB, avg={avg_ms:.1f}ms, "
            f"p95={p95_ms:.1f}ms, outputs={out_shapes}"
        )
        results.append((name, size_mb, avg_ms, p95_ms))

    # Write BENCHMARKS.md (utf-8, ASCII dash to avoid mojibake on Windows)
    with open("../BENCHMARKS.md", "w", encoding="utf-8") as f:
        f.write("# BENCHMARKS.md - Model Performance\n\n")
        f.write("| Model | Size (MB) | Avg Latency (ms) | P95 Latency (ms) |\n")
        f.write("|---|---|---|---|\n")
        for name, size, avg, p95 in results:
            f.write(f"| {name} | {size:.2f} | {avg:.1f} | {p95:.1f} |\n")
        total_mb = sum(r[1] for r in results)
        total_ms = sum(r[2] for r in results[:3])  # pipeline: detect+liveness+recognise
        f.write(f"\n**Total bundle size:** {total_mb:.2f} MB\n")
        f.write(f"**Estimated pipeline latency (CPU):** ~{total_ms:.0f} ms\n")

    print("\nBENCHMARKS.md written.")


if __name__ == "__main__":
    main()
