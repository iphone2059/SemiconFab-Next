"""Compare paired, same-viewport browser PNGs; never upgrades parity status.

Optional tooling dependencies: pip install -r tools/visual-requirements.txt
SSIM uses an 11x11 Gaussian (sigma=1.5), population covariance, luminance.
No alignment/colour correction is applied: camera/HUD differences must count.
"""
from __future__ import annotations
import argparse
import csv
import hashlib
import json
from pathlib import Path


def image_metrics(left, right):
    import numpy as np
    if left.shape != right.shape or left.ndim != 3 or left.shape[2] != 3:
        raise ValueError('Golden RGB dimensions differ')
    a, b = left.astype('float64'), right.astype('float64')
    delta = np.abs(a - b)
    weights = np.array([0.2126, 0.7152, 0.0722])
    x, y = a @ weights, b @ weights
    kernel = np.exp(-np.arange(-5, 6, dtype='float64') ** 2 / (2 * 1.5 ** 2))
    kernel /= kernel.sum()

    def blur(values):
        padded = np.pad(values, ((0, 0), (5, 5)), mode='reflect')
        result = sum(weight * padded[:, i:i + values.shape[1]] for i, weight in enumerate(kernel))
        padded = np.pad(result, ((5, 5), (0, 0)), mode='reflect')
        return sum(weight * padded[i:i + values.shape[0], :] for i, weight in enumerate(kernel))

    ux, uy = blur(x), blur(y)
    vx, vy, cov = blur(x * x) - ux * ux, blur(y * y) - uy * uy, blur(x * y) - ux * uy
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    score = ((2 * ux * uy + c1) * (2 * cov + c2)) / ((ux * ux + uy * uy + c1) * (vx + vy + c2))
    return {'ssim': float(score[5:-5, 5:-5].mean()), 'mae_rgb': float(delta.mean()),
            'changed_fraction_gt8': float((delta.max(axis=2) > 8).mean())}


def compare_pair(root: Path, case: str):
    import numpy as np
    from PIL import Image
    names = [f'{side}-{case}' for side in ('original', 'next')]
    records = [json.loads((root / f'{name}.json').read_text(encoding='utf-8')) for name in names]
    if records[0]['viewport'] != records[1]['viewport']:
        raise ValueError(f'{case}: viewport/DPR mismatch')
    arrays = [np.asarray(Image.open(root / f'{name}.png').convert('RGB')) for name in names]
    full = image_metrics(*arrays)
    height, width = arrays[0].shape[:2]
    # Common visible scene excludes the left rail and top/bottom HUD. Full-frame
    # metrics remain mandatory, so this ROI cannot conceal a HUD mismatch.
    x0, y0, x1, y1 = 328, 82, width, height - 48
    scene = image_metrics(*(array[y0:y1, x0:x1] for array in arrays))
    magnitude = np.abs(arrays[0].astype('int16') - arrays[1].astype('int16')).max(axis=2)
    heat = np.zeros_like(arrays[0]); heat[:, :, 0] = np.minimum(255, magnitude * 4)
    Image.fromarray(heat).save(root / f'diff-{case}.png')
    return {'case': case, 'viewport': records[0]['viewport'], 'png_size': [width, height],
            'sha256': {name: hashlib.sha256((root / f'{name}.png').read_bytes()).hexdigest() for name in names},
            'full_frame': full, 'scene_roi': {'rect': [x0, y0, x1, y1], **scene},
            'status': 'REVIEW_REQUIRED', 'threshold_approved': False}


def runtime_inventory(root: Path):
    rows = list(csv.DictReader((root.parent.parent / 'controls.csv').read_text(encoding='utf-8').splitlines()))
    source = {row['original_id'] for row in rows}
    coverage = {side: {} for side in ('original', 'next')}
    for path in sorted(root.glob('*.json')):
        if not path.name.startswith(('original-', 'next-')):
            continue
        record = json.loads(path.read_text(encoding='utf-8'))
        for element in record['ids']:
            visible = (element['width'] > 0 and element['height'] > 0 and element['visibility'] == 'visible'
                       and element['x'] < record['viewport']['width'] and element['y'] < record['viewport']['height']
                       and element['x'] + element['width'] > 0 and element['y'] + element['height'] > 0)
            if visible:
                coverage[record['side']].setdefault(element['id'], []).append(record['case'])
    report = {'status': 'PARTIAL_RUNTIME_INVENTORY', 'original_raw_occurrences': len(rows),
              'original_unique_source_ids': len(source), 'original_ids_visible_in_captures': len(source & coverage['original'].keys()),
              'not_yet_visible': sorted(source - coverage['original'].keys()),
              'same_id_visible_in_next': sorted(source & coverage['next'].keys()), 'visible_cases': coverage,
              'limitation': 'DOM rectangles only, not occlusion/tooltip/event/video acceptance. Template IDs still need dynamic binding. No parity claim.'}
    (root.parent / 'runtime-coverage.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('docs/migration/twin-parity/evidence/golden'))
    args = parser.parse_args()
    cases = sorted(path.stem.removeprefix('original-') for path in args.root.glob('original-*.png')
                   if (args.root / path.name.replace('original-', 'next-', 1)).exists())
    results = [compare_pair(args.root, case) for case in cases]
    report = {'method': 'Gaussian luminance SSIM 11x11 sigma=1.5; population covariance; RGB threshold=8',
              'status': 'NOT_PARITY_VERIFIED', 'cases': results}
    (args.root / 'comparison.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    runtime_inventory(args.root)
    print(json.dumps({entry['case']: round(entry['full_frame']['ssim'], 5) for entry in results}))


if __name__ == '__main__':
    main()
